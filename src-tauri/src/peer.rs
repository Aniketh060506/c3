use axum::{
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, Extension, Path, State},
    http::{header::AUTHORIZATION, Request, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::{HashMap, HashSet}, net::SocketAddr, path::Path as FsPath, process::{Command, Output, Stdio}, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex, OnceLock}};
use tokio::net::TcpListener;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CLIENT_ID: &str = "794gej34ru6dce5b7bqhfu165e";
const PORT: u16 = 47631;
const ISSUER: &str = "https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_xAlBWSAWs";
const JWKS: &str = "https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_xAlBWSAWs/.well-known/jwks.json";

#[derive(Clone)]
struct PeerServer(Arc<PeerState>);

struct PeerState {
    jwks: Value,
    profile: Mutex<Value>,
    cluster_sessions: Mutex<HashMap<String, (String, String, String, String)>>,
    starting_sessions: Mutex<HashMap<String, (String, String)>>,
    cancelled_sessions: Mutex<HashSet<String>>,
}

#[derive(Clone)]
struct Identity { sub: String, name: String, id_token: String }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClusterJoinDraft { session_id: String, consumer_request_id: String, server_ip: String, server_token: String, provider_ip: String }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClusterLeaveDraft { session_id: String }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeExecDraft { session_id: String, command: String }

static SERVER: OnceLock<Arc<PeerState>> = OnceLock::new();
static SERVER_RUNNING: AtomicBool = AtomicBool::new(false);
static LOCAL_PROFILE: OnceLock<Mutex<Value>> = OnceLock::new();

pub async fn set_online(online: bool, netbird_ip: &str, profile: Value) -> Result<(), String> {
    *LOCAL_PROFILE.get_or_init(|| Mutex::new(profile.clone())).lock().map_err(|_| "Provider state is unavailable.".to_string())? = profile.clone();
    if online {
        if netbird_ip.parse::<std::net::IpAddr>().is_err() { return Err("NetBird has not assigned this laptop a peer IP. Connect NetBird before going online.".into()); }
        let state = if let Some(state) = SERVER.get() { state.clone() } else {
            let jwks = reqwest::Client::new().get(JWKS).send().await
                .map_err(|e| format!("Could not load Cognito signing keys for peer authentication: {e}"))?
                .error_for_status().map_err(|e| format!("Could not load Cognito signing keys: {e}"))?
                .json::<Value>().await.map_err(|e| format!("Cognito signing keys were invalid: {e}"))?;
            let state = Arc::new(PeerState { jwks, profile: Mutex::new(profile.clone()), cluster_sessions: Mutex::new(HashMap::new()), starting_sessions: Mutex::new(HashMap::new()), cancelled_sessions: Mutex::new(HashSet::new()) });
            let _ = SERVER.set(state.clone());
            SERVER.get().cloned().unwrap_or(state)
        };
        *state.profile.lock().map_err(|_| "Provider state is unavailable.".to_string())? = profile;
            let _: std::net::IpAddr = netbird_ip.parse().map_err(|_| "Invalid NetBird peer IP.".to_string())?;
            // Bind on all interfaces so a NetBird address change does not strand the
            // peer service. Requests are separately rejected unless their source is
            // in NetBird's CGNAT range, and Windows Firewall scopes this port there too.
            let addr = SocketAddr::from(([0, 0, 0, 0], PORT));
        if !SERVER_RUNNING.swap(true, Ordering::SeqCst) {
            let listener = match TcpListener::bind(addr).await {
                Ok(listener) => listener,
                Err(e) => { SERVER_RUNNING.store(false, Ordering::SeqCst); return Err(format!("Could not start the private NetBird peer service on {addr}: {e}. Allow TCP {PORT} on the NetBird interface.")); }
            };
            let middleware_state = state.clone();
            let app = Router::new()
                .route("/v1/cluster/join", post(join_cluster))
                .route("/v1/cluster/leave", post(leave_cluster))
                .route("/v1/cluster/node/exec", post(execute_node_command))
                .route("/v1/cluster/data/{session}/{job}/input", post(stage_input))
                .route("/v1/cluster/data/{session}/{job}/output", get(read_output))
                .with_state(PeerServer(state))
                .layer(DefaultBodyLimit::max(268_435_456))
                .layer(middleware::from_fn_with_state(middleware_state, authorize));
            tokio::spawn(async move { let _ = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await; SERVER_RUNNING.store(false, Ordering::SeqCst); });
        }
    } else if let Some(state) = SERVER.get() {
        if let Ok(mut profile) = state.profile.lock() { profile["online"] = json!(false); }
    }
    Ok(())
}

async fn authorize(State(state): State<Arc<PeerState>>, mut request: Request<axum::body::Body>, next: Next) -> Result<Response, StatusCode> {
    if state.profile.lock().map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?.get("online").and_then(Value::as_bool) != Some(true) { return Err(StatusCode::SERVICE_UNAVAILABLE); }
    let remote_ip = request.extensions().get::<ConnectInfo<SocketAddr>>().map(|info| info.0.ip()).ok_or(StatusCode::FORBIDDEN)?;
    if !is_netbird_ip(remote_ip) { return Err(StatusCode::FORBIDDEN); }
    let token = request.headers().get(AUTHORIZATION).and_then(|h| h.to_str().ok()).and_then(|h| h.strip_prefix("Bearer ")).ok_or(StatusCode::UNAUTHORIZED)?.to_string();
    let header = decode_header(&token).map_err(|_| StatusCode::UNAUTHORIZED)?;
    let kid = header.kid.ok_or(StatusCode::UNAUTHORIZED)?;
    let key = state.jwks.get("keys").and_then(Value::as_array).and_then(|keys| keys.iter().find(|key| key.get("kid").and_then(Value::as_str) == Some(kid.as_str()))).ok_or(StatusCode::UNAUTHORIZED)?;
    let n = key.get("n").and_then(Value::as_str).ok_or(StatusCode::UNAUTHORIZED)?;
    let e = key.get("e").and_then(Value::as_str).ok_or(StatusCode::UNAUTHORIZED)?;
    let decoding_key = DecodingKey::from_rsa_components(n, e).map_err(|_| StatusCode::UNAUTHORIZED)?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[ISSUER]);
    validation.set_audience(&[CLIENT_ID]);
    let claims = decode::<Value>(&token, &decoding_key, &validation).map_err(|_| StatusCode::UNAUTHORIZED)?.claims;
    if claims.get("token_use").and_then(Value::as_str) != Some("id") { return Err(StatusCode::UNAUTHORIZED); }
    request.extensions_mut().insert(Identity {
        sub: claims.get("sub").and_then(Value::as_str).unwrap_or_default().to_string(),
        name: claims.get("name").or_else(|| claims.get("given_name")).and_then(Value::as_str).unwrap_or_else(|| claims.get("email").and_then(Value::as_str).unwrap_or("ComputePool user")).to_string(),
        id_token: token,
    });
    Ok(next.run(request).await)
}

fn is_netbird_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => {
            let octets = ip.octets();
            octets[0] == 100 && (64..=127).contains(&octets[1])
        }
        std::net::IpAddr::V6(_) => false,
    }
}

#[axum::debug_handler]
async fn join_cluster(State(server): State<PeerServer>, Extension(identity): Extension<Identity>, Json(draft): Json<ClusterJoinDraft>) -> Result<Json<Value>, (StatusCode, String)> {
    if !valid_name(&draft.session_id) || draft.server_ip.parse::<std::net::IpAddr>().is_err() || draft.provider_ip.parse::<std::net::IpAddr>().is_err() || draft.server_token.len() < 32 || draft.server_token.len() > 1024 { return Err((StatusCode::BAD_REQUEST, "Cluster join details are invalid.".into())); }
    let profile = server.0.profile.lock().map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Provider profile is unavailable.".into()))?.clone();
    if profile.get("netbirdIp").and_then(Value::as_str) != Some(draft.provider_ip.as_str()) { return Err((StatusCode::FORBIDDEN, "Provider NetBird address does not match this peer.".into())); }
    let api_base = option_env!("COMPUTEPOOL_API_URL").ok_or((StatusCode::SERVICE_UNAVAILABLE, "ComputePool AWS API is not configured in this build.".into()))?;
    let response = reqwest::Client::new().get(format!("{}/negotiations", api_base.trim_end_matches('/'))).bearer_auth(&identity.id_token).send().await.map_err(|_| (StatusCode::BAD_GATEWAY, "Could not verify this accepted request with ComputePool.".into()))?;
    if !response.status().is_success() { return Err((StatusCode::BAD_GATEWAY, "ComputePool did not authorize this worker join.".into())); }
    let negotiations = response.json::<Value>().await.map_err(|_| (StatusCode::BAD_GATEWAY, "ComputePool returned invalid negotiation data.".into()))?;
    let accepted = negotiations.as_array().into_iter().flatten().find(|item| item.get("id").and_then(Value::as_str) == Some(draft.consumer_request_id.as_str()) && item.get("state").and_then(Value::as_str) == Some("accepted") && item.get("providerId").and_then(Value::as_str) == profile.get("id").and_then(Value::as_str));
    let Some(accepted) = accepted else { return Err((StatusCode::FORBIDDEN, "Only the consumer with an accepted request for this provider can attach the worker.".into())); };
    let session_id = draft.session_id.clone();
    let node_name = format!("cp-{}", draft.provider_ip.replace('.', "-"));
    let consumer_request_id = draft.consumer_request_id.clone();
    let ip = draft.provider_ip;
    let server_ip = draft.server_ip;
    let token = draft.server_token;
    let cpu_limit = profile.pointer("/limits/cpuCores").and_then(Value::as_f64).filter(|value| *value >= 1.0).ok_or((StatusCode::CONFLICT, "Provider CPU allocation is missing. Update provider limits and accept the request again.".into()))?;
    let memory_limit = profile.pointer("/limits/memoryBytes").and_then(Value::as_u64).filter(|value| *value > 0).ok_or((StatusCode::CONFLICT, "Provider memory allocation is missing. Update provider limits and accept the request again.".into()))?;
    let requested = accepted.get("requestedLimits").cloned().unwrap_or(Value::Null);
    let requested_cpu = requested.get("cpuCores").and_then(Value::as_f64).filter(|value| *value >= 1.0 && *value <= cpu_limit).ok_or((StatusCode::CONFLICT, "The accepted CPU allocation exceeds this provider's current limit.".into()))?;
    let requested_memory = requested.get("memoryBytes").and_then(Value::as_u64).filter(|value| *value > 0 && *value <= memory_limit).ok_or((StatusCode::CONFLICT, "The accepted memory allocation exceeds this provider's current limit.".into()))?;
    let offered_gpu_ids = profile.pointer("/limits/gpuIds").and_then(Value::as_array).cloned().unwrap_or_default();
    let requested_gpu_ids = requested.get("gpuIds").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter_map(|id| id.as_str().map(ToOwned::to_owned)).collect::<Vec<_>>();
    if requested_gpu_ids.iter().any(|id| !offered_gpu_ids.iter().any(|offered| offered.as_str() == Some(id.as_str()))) {
        return Err((StatusCode::CONFLICT, "The accepted GPU allocation is no longer offered by this provider.".into()));
    }
    {
        let sessions = server.0.cluster_sessions.lock().map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Provider session list is unavailable.".into()))?;
        if let Some(owner) = sessions.get(&draft.session_id) {
            if owner.0 != identity.sub { return Err((StatusCode::FORBIDDEN, "Only the consumer that started this worker can retry its join.".into())); }
            return Ok(Json(json!({"nodeName":node_name,"container":format!("cp-agent-{}",draft.session_id),"state":"active"})));
        }
        let mut starting = server.0.starting_sessions.lock().map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Provider startup state is unavailable.".into()))?;
        if let Some(owner) = starting.get(&draft.session_id) {
            if owner.0 != identity.sub { return Err((StatusCode::FORBIDDEN, "Only the consumer that started this worker can retry its join.".into())); }
            return Ok(Json(json!({"nodeName":node_name,"container":format!("cp-agent-{}",draft.session_id),"state":"starting"})));
        }
        if server.0.cancelled_sessions.lock().map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Provider cancellation state is unavailable.".into()))?.contains(&draft.session_id) {
            return Err((StatusCode::CONFLICT, "This worker startup was already cancelled. Start a new accepted session.".into()));
        }
        starting.insert(draft.session_id.clone(), (identity.sub.clone(), draft.consumer_request_id.clone()));
    }
    let start_session_id = session_id.clone();
    let worker_result = tokio::task::spawn_blocking(move || start_worker_container(&start_session_id, &ip, &server_ip, &token, requested_cpu, requested_memory, &requested_gpu_ids)).await;
    let result = match worker_result {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            if let Ok(mut starting) = server.0.starting_sessions.lock() { starting.remove(&draft.session_id); }
            if let Ok(mut cancelled) = server.0.cancelled_sessions.lock() { cancelled.remove(&draft.session_id); }
            return Err((StatusCode::SERVICE_UNAVAILABLE, error));
        }
        Err(_) => {
            if let Ok(mut starting) = server.0.starting_sessions.lock() { starting.remove(&draft.session_id); }
            if let Ok(mut cancelled) = server.0.cancelled_sessions.lock() { cancelled.remove(&draft.session_id); }
            return Err((StatusCode::INTERNAL_SERVER_ERROR, "Provider worker startup task failed.".into()));
        }
    };
    let cancelled = {
        let mut sessions = server.0.cluster_sessions.lock().map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Provider session list is unavailable.".into()))?;
        let mut starting = server.0.starting_sessions.lock().map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Provider startup state is unavailable.".into()))?;
        let mut cancelled = server.0.cancelled_sessions.lock().map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Provider cancellation state is unavailable.".into()))?;
        if cancelled.remove(&draft.session_id) {
            starting.remove(&draft.session_id);
            true
        } else {
            sessions.insert(draft.session_id.clone(), (identity.sub.clone(), identity.name.clone(), now_iso(), consumer_request_id));
            starting.remove(&draft.session_id);
            false
        }
    };
    if cancelled {
        let stop_session_id = draft.session_id.clone();
        let _ = tokio::task::spawn_blocking(move || stop_worker_container(&stop_session_id)).await;
        return Err((StatusCode::CONFLICT, "This worker startup was cancelled because the ComputePool session ended.".into()));
    }
    Ok(Json(result))
}

async fn leave_cluster(State(server): State<PeerServer>, Extension(identity): Extension<Identity>, Json(draft): Json<ClusterLeaveDraft>) -> Result<Json<Value>, (StatusCode, String)> {
    if !valid_name(&draft.session_id) { return Err((StatusCode::BAD_REQUEST, "Cluster session ID is invalid.".into())); }
    let owner = server.0.cluster_sessions.lock().map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Provider session list is unavailable.".into()))?.get(&draft.session_id).cloned();
    let starting_owner = server.0.starting_sessions.lock().map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Provider startup state is unavailable.".into()))?.get(&draft.session_id).cloned();
    if let Some(owner) = owner.as_ref() { if owner.0 != identity.sub { return Err((StatusCode::FORBIDDEN, "Only the consumer that started this worker can stop it.".into())); } }
    if let Some(owner) = starting_owner.as_ref() { if owner.0 != identity.sub { return Err((StatusCode::FORBIDDEN, "Only the consumer that started this worker can cancel its startup.".into())); } }
    if owner.is_none() && starting_owner.is_none() {
        let mut cancelled = server.0.cancelled_sessions.lock().map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Provider cancellation state is unavailable.".into()))?;
        if cancelled.len() >= 4096 { cancelled.clear(); }
        cancelled.insert(draft.session_id.clone());
        return Ok(Json(json!({"container":format!("cp-agent-{}", draft.session_id), "state":"already_stopped"})));
    }
    server.0.cancelled_sessions.lock().map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Provider cancellation state is unavailable.".into()))?.insert(draft.session_id.clone());
    if owner.is_none() { return Ok(Json(json!({"container":format!("cp-agent-{}", draft.session_id), "state":"stopping"}))); }
    let session = draft.session_id.clone();
    let result = tokio::task::spawn_blocking(move || stop_worker_container(&session)).await.map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Provider worker stop task failed.".into()))?.map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e))?;
    server.0.cluster_sessions.lock().map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Provider session list is unavailable.".into()))?.remove(&draft.session_id);
    server.0.cancelled_sessions.lock().map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Provider cancellation state is unavailable.".into()))?.remove(&draft.session_id);
    Ok(Json(result))
}

async fn execute_node_command(State(server): State<PeerServer>, Extension(identity): Extension<Identity>, Json(draft): Json<NodeExecDraft>) -> Result<Json<Value>, (StatusCode, String)> {
    if !valid_name(&draft.session_id) { return Err((StatusCode::BAD_REQUEST, "Cluster session ID is invalid.".into())); }
    let authorized = server.0.cluster_sessions.lock().map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Provider session state is unavailable.".into()))?.get(&draft.session_id).is_some_and(|owner| owner.0 == identity.sub);
    if !authorized { return Err((StatusCode::FORBIDDEN, "Only the consumer that started this worker can use its provider shell.".into())); }
    let command = draft.command.trim().to_string();
    if command.is_empty() || command.len() > 16_000 { return Err((StatusCode::BAD_REQUEST, "Enter a provider shell command between 1 and 16000 characters.".into())); }
    let result = tokio::task::spawn_blocking(move || {
        #[cfg(windows)]
        let output = hidden_command("powershell.exe").args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", &command]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).output();
        #[cfg(not(windows))]
        let output = hidden_command("sh").args(["-lc", &command]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).output();
        output.map_err(|error| format!("Could not execute command on provider: {error}"))
    }).await.map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Provider shell task failed.".into()))?.map_err(|error| (StatusCode::SERVICE_UNAVAILABLE, error))?;
    Ok(Json(json!({"stdout": String::from_utf8_lossy(&result.stdout), "stderr": String::from_utf8_lossy(&result.stderr), "exitCode": result.status.code().unwrap_or(-1)})))
}

#[axum::debug_handler]
async fn stage_input(State(server): State<PeerServer>, Extension(identity): Extension<Identity>, Path((session, job)): Path<(String, String)>, body: Bytes) -> Result<Json<Value>, (StatusCode, String)> {
    let authorized = { let sessions = server.0.cluster_sessions.lock().map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Provider session state is unavailable.".into()))?; sessions.get(&session).is_some_and(|owner| owner.0 == identity.sub) };
    if !authorized { return Err((StatusCode::FORBIDDEN, "This consumer does not own the worker session.".into())); }
    if !valid_name(&job) { return Err((StatusCode::BAD_REQUEST, "Workload ID is invalid.".into())); }
    if body.is_empty() || body.len() > 268_435_456 { return Err((StatusCode::PAYLOAD_TOO_LARGE, "Input archive must be between 1 byte and 256 MiB.".into())); }
    let bytes = body.to_vec();
    let id = session.clone(); let workload = job.clone();
    tokio::task::spawn_blocking(move || docker_exec_input(&id, &workload, &bytes)).await.map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Input staging task failed.".into()))?.map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e))?;
    Ok(Json(json!({"sessionId":session,"jobId":job,"state":"staged","bytes":body.len()})))
}

#[axum::debug_handler]
async fn read_output(State(server): State<PeerServer>, Extension(identity): Extension<Identity>, Path((session, job)): Path<(String, String)>) -> Result<Response, (StatusCode, String)> {
    let authorized = { let sessions = server.0.cluster_sessions.lock().map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Provider session state is unavailable.".into()))?; sessions.get(&session).is_some_and(|owner| owner.0 == identity.sub) };
    if !authorized { return Err((StatusCode::FORBIDDEN, "This consumer does not own the worker session.".into())); }
    if !valid_name(&job) { return Err((StatusCode::BAD_REQUEST, "Workload ID is invalid.".into())); }
    let id = session.clone();
    let bytes = tokio::task::spawn_blocking(move || {
        let container = format!("cp-agent-{id}");
        let path = format!("/workspace/jobs/{job}/output");
        let _ = docker_output(&["exec", &container, "sh", "-lc", &format!("mkdir -p {path}")])?;
        hidden_command("docker.exe").args(["exec", &container, "tar", "-czf", "-", "-C", &path, "."]).output()
            .or_else(|_| hidden_command("docker").args(["exec", &container, "tar", "-czf", "-", "-C", &path, "."]).output())
            .map_err(|e| format!("Could not collect provider output files: {e}"))
    }).await.map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Output collection task failed.".into()))?.map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e))?;
    if !bytes.status.success() { return Err((StatusCode::SERVICE_UNAVAILABLE, format!("Could not archive provider output: {}", String::from_utf8_lossy(&bytes.stderr)))); }
    if bytes.stdout.len() > 268_435_456 { return Err((StatusCode::PAYLOAD_TOO_LARGE, "Provider output archive is larger than 256 MiB.".into())); }
    Ok(Response::builder().header("content-type", "application/octet-stream").body(axum::body::Body::from(bytes.stdout)).map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Could not return provider output archive.".into()))?)
}

fn docker_exec_input(session: &str, job: &str, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let container = format!("cp-agent-{session}");
    let path = format!("/workspace/jobs/{job}/input");
    let make = docker_output(&["exec", &container, "sh", "-lc", &format!("mkdir -p {path}")])?;
    if !make.status.success() { return Err(format!("Could not prepare provider input directory: {}", String::from_utf8_lossy(&make.stderr))); }
    {
        let mut child = hidden_command("docker.exe").args(["exec", "-i", &container, "tar", "-xzf", "-", "-C", &path]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
            .or_else(|_| hidden_command("docker").args(["exec", "-i", &container, "tar", "-xzf", "-", "-C", &path]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn())
            .map_err(|e| format!("Could not start provider input staging: {e}"))?;
        if let Some(mut stdin) = child.stdin.take() { stdin.write_all(bytes).map_err(|e| format!("Could not send input files to provider: {e}"))?; }
        let result = child.wait_with_output().map_err(|e| format!("Could not complete provider input staging: {e}"))?;
        if !result.status.success() { return Err(format!("Provider could not unpack input archive: {}", String::from_utf8_lossy(&result.stderr))); }
    }
    Ok(())
}

pub async fn upload_input(provider: &Value, id_token: &str, session: &str, job: &str, archive: Vec<u8>) -> Result<(), String> {
    let ip = provider.get("netbirdIp").and_then(Value::as_str).ok_or("Provider has no NetBird address.")?;
    let response = reqwest::Client::new().post(format!("http://{ip}:{PORT}/v1/cluster/data/{session}/{job}/input")).bearer_auth(id_token).header("content-type", "application/octet-stream").body(archive).send().await.map_err(|e| format!("Could not stage input on provider: {e}"))?;
    if !response.status().is_success() { return Err(format!("Provider rejected input staging (HTTP {}).", response.status())); }
    Ok(())
}

pub async fn download_output(provider: &Value, id_token: &str, session: &str, job: &str) -> Result<Vec<u8>, String> {
    let ip = provider.get("netbirdIp").and_then(Value::as_str).ok_or("Provider has no NetBird address.")?;
    let response = reqwest::Client::new().get(format!("http://{ip}:{PORT}/v1/cluster/data/{session}/{job}/output")).bearer_auth(id_token).send().await.map_err(|e| format!("Could not collect output from provider: {e}"))?;
    let status = response.status();
    if !status.is_success() { return Err(format!("Provider rejected output collection (HTTP {status}).")); }
    let bytes = response.bytes().await.map_err(|e| format!("Provider returned invalid output data: {e}"))?;
    if bytes.len() > 268_435_456 { return Err("Provider output archive is larger than 256 MiB.".into()); }
    Ok(bytes.to_vec())
}

fn valid_name(value: &str) -> bool { !value.is_empty() && value.len() <= 32 && value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') }

fn hidden_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

fn docker_output(args: &[&str]) -> Result<Output, String> {
    let mut candidates = Vec::new();
    if let Ok(program_files) = std::env::var("ProgramFiles") { candidates.push(format!("{program_files}\\Docker\\Docker\\resources\\bin\\docker.exe")); }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") { candidates.push(format!("{local_app_data}\\Programs\\DockerDesktop\\resources\\bin\\docker.exe")); }
    candidates.extend(["docker.exe".to_string(), "docker".to_string()]);
    let candidates = candidates.into_iter().filter(|candidate| !candidate.contains('\\') || FsPath::new(candidate).is_file()).collect::<Vec<_>>();
    let mut last = None;
    let mut last_error = None;
    for cli in candidates {
        let desktop_ready = hidden_command(&cli).args(["--context", "desktop-linux", "info", "--format", "{{.ServerVersion}}"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).output().ok().is_some_and(|output| output.status.success());
        let mut command = hidden_command(&cli);
        if desktop_ready { command.args(["--context", "desktop-linux"]); }
        match command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).output() {
            Ok(output) if output.status.success() => return Ok(output),
            Ok(output) => last = Some(output),
            Err(error) => last_error = Some(error.to_string()),
        }
    }
    last.ok_or_else(|| last_error.map(|error| format!("Docker Desktop is not available: {error}")).unwrap_or_else(|| "Docker Desktop CLI was not found on PATH or in its standard install folders.".to_string()))
}

fn output_text(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() { stderr } else { String::from_utf8_lossy(&output.stdout).trim().to_string() }
}

fn start_worker_container(session: &str, provider_ip: &str, server_ip: &str, token: &str, cpu_limit: f64, memory_limit: u64, gpu_ids: &[String]) -> Result<Value, String> {
    let info = docker_output(&["info", "--format", "{{.ServerVersion}}"])?;
    if !info.status.success() { return Err("Docker Desktop is installed but its engine is not running on this provider.".into()); }
    let container = format!("cp-agent-{session}");
    let volume = format!("cp-data-{session}");
    let name = format!("cp-{}", provider_ip.replace('.', "-"));
    if !gpu_ids.is_empty() {
        return Err("GPU hardware may be detected, but K3s GPU device-plugin scheduling is not configured in this build. Remove GPU devices from this request and retry.".into());
    }
    let vol = docker_output(&["volume", "create", &volume])?;
    if !vol.status.success() { return Err(format!("Could not create provider workload volume: {}", String::from_utf8_lossy(&vol.stderr))); }
    let image = "rancher/k3s:v1.31.5-k3s1";
    // When consumer and provider are the same NetBird peer, both Docker nodes
    // would otherwise advertise the same host IP and publish kubelet port 10250
    // there. Kubernetes then proxies `kubectl exec` to the wrong kubelet. On a
    // shared Docker host, let the worker advertise its unique bridge IP instead;
    // the control-plane container can reach it directly on the Docker bridge.
    let same_docker_host = provider_ip == server_ip;
    let mut args = vec!["run".to_string(), "-d".into(), "--name".into(), container.clone(), "--label".into(), "com.computepool.managed=true".into(), "--label".into(), "com.computepool.role=worker".into(), "--privileged".into()];
    args.extend(["--cpus".into(), cpu_limit.to_string(), "--memory".into(), format!("{memory_limit}b"), "--memory-swap".into(), format!("{memory_limit}b")]);
    if !same_docker_host {
        args.extend(["--publish".into(), format!("{provider_ip}:8472:8472/udp"), "--publish".into(), format!("{provider_ip}:10250:10250/tcp")]);
    }
    args.extend(["--volume".into(), format!("{volume}:/workspace"), "--env".into(), format!("K3S_URL=https://{server_ip}:6443"), "--env".into(), format!("K3S_TOKEN={token}"), "--env".into(), format!("K3S_NODE_NAME={name}"), image.into(), "agent".into()]);
    if same_docker_host {
        args.extend(["--node-external-ip".into(), provider_ip.into()]);
    } else {
        args.extend(["--node-ip".into(), provider_ip.into(), "--node-external-ip".into(), provider_ip.into()]);
    }
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    match docker_output(&refs) {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            let message = output_text(&output);
            let _ = docker_output(&["rm", "-f", &container]);
            let _ = docker_output(&["volume", "rm", &volume]);
            return Err(format!("Could not join the shared K3s cluster: {message}"));
        }
        Err(error) => {
            let _ = docker_output(&["rm", "-f", &container]);
            let _ = docker_output(&["volume", "rm", &volume]);
            return Err(error);
        }
    };
    Ok(json!({"nodeName": name, "container": container, "state": "starting"}))
}

fn stop_worker_container(session: &str) -> Result<Value, String> {
    let container = format!("cp-agent-{session}");
    let output = docker_output(&["rm", "-f", &container])?;
    if !output.status.success() && !String::from_utf8_lossy(&output.stderr).contains("No such container") { return Err(format!("Could not stop provider worker: {}", String::from_utf8_lossy(&output.stderr))); }
    let volume = format!("cp-data-{session}");
    let _ = docker_output(&["volume", "rm", &volume]);
    Ok(json!({"container": container, "state": "stopped"}))
}

pub async fn remote_request_action(provider: &Value, id_token: &str, request_id: &str, endpoint: &str, body: Value) -> Result<Value, String> {
    let ip = provider.get("netbirdIp").and_then(Value::as_str).ok_or("Provider has no NetBird address.")?;
    let _ = request_id;
    let path = if endpoint == "cluster/join" { "/v1/cluster/join" } else { return Err("Unsupported provider peer action.".into()); };
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(8)).build().map_err(|e| format!("Could not configure provider connection: {e}"))?;
    let response = client.post(format!("http://{ip}:{PORT}{path}")).bearer_auth(id_token).json(&body).send().await.map_err(|e| format!("Could not contact provider peer at {ip}:{PORT}: {e}"))?;
    let status = response.status();
    let body = response.json::<Value>().await.map_err(|e| format!("Provider returned invalid response: {e}"))?;
    if !status.is_success() { return Err(format!("Provider rejected the request (HTTP {status}): {body}")); }
    Ok(body)
}

pub async fn remote_service_action(provider: &Value, id_token: &str, endpoint: &str, body: Value) -> Result<Value, String> {
    let ip = provider.get("netbirdIp").and_then(Value::as_str).ok_or("Provider has no NetBird address.")?;
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(8)).build().map_err(|e| format!("Could not configure provider connection: {e}"))?;
    let response = client.post(format!("http://{ip}:{PORT}/v1/{endpoint}")).bearer_auth(id_token).json(&body).send().await.map_err(|e| format!("Could not contact provider peer at {ip}:{PORT}: {e}"))?;
    let status = response.status();
    let body = response.json::<Value>().await.map_err(|e| format!("Provider returned invalid response: {e}"))?;
    if !status.is_success() { return Err(format!("Provider rejected the request (HTTP {status}): {body}")); }
    Ok(body)
}

pub fn local_profile() -> Value { LOCAL_PROFILE.get_or_init(|| Mutex::new(Value::Null)).lock().map(|v| v.clone()).unwrap_or(Value::Null) }
pub fn set_local_limits(limits: Value) -> Result<Value, String> {
    let mut profile = LOCAL_PROFILE.get_or_init(|| Mutex::new(Value::Null)).lock().map_err(|_| "Provider state is unavailable.".to_string())?;
    if profile.is_null() { *profile = json!({"online": false, "limits": limits}); } else { profile["limits"] = limits; }
    if let Some(server) = SERVER.get() { if let Ok(mut server_profile) = server.profile.lock() { *server_profile = profile.clone(); } }
    Ok(profile.clone())
}
pub fn local_sessions() -> Vec<Value> {
    let Some(server) = SERVER.get() else { return Vec::new(); };
    let Ok(sessions) = server.cluster_sessions.lock() else { return Vec::new(); };
    sessions.iter().map(|(id, (_, consumer, started_at, _))| {
        let container = format!("cp-agent-{id}");
        let stats = hidden_command("docker.exe").args(["stats", "--no-stream", "--format", "{{.CPUPerc}}|{{.MemUsage}}", &container]).output()
            .or_else(|_| hidden_command("docker").args(["stats", "--no-stream", "--format", "{{.CPUPerc}}|{{.MemUsage}}", &container]).output()).ok();
        let (cpu, memory) = stats.filter(|o| o.status.success()).and_then(|o| String::from_utf8(o.stdout).ok()).and_then(|s| {
            let mut parts = s.trim().split('|');
            let cpu = parts.next()?.trim().trim_end_matches('%').parse::<f32>().ok();
            let memory_text = parts.next()?.split('/').next()?.trim();
            let split_at = memory_text.find(|c: char| !c.is_ascii_digit() && c != '.').unwrap_or(memory_text.len());
            let number = memory_text[..split_at].parse::<f64>().ok()?;
            let factor = match &memory_text[split_at..] { "GiB" => 1024_f64.powi(3), "MiB" => 1024_f64.powi(2), "KiB" => 1024_f64, _ => 1.0 };
            Some((cpu, Some((number * factor) as u64)))
        }).unwrap_or((None, None));
        json!({"id": id, "consumer": consumer, "state": "active", "startedAt": started_at, "cpuPercent": cpu, "memoryBytes": memory})
    }).collect()
}

pub fn shutdown_workers() -> Result<(), String> {
    let Some(server) = SERVER.get() else { return Ok(()); };
    let mut session_ids = server.cluster_sessions.lock().map_err(|_| "Provider session list is unavailable.".to_string())?.keys().cloned().collect::<HashSet<_>>();
    session_ids.extend(server.starting_sessions.lock().map_err(|_| "Provider startup state is unavailable.".to_string())?.keys().cloned());
    {
        let mut cancelled = server.cancelled_sessions.lock().map_err(|_| "Provider cancellation state is unavailable.".to_string())?;
        cancelled.extend(session_ids.iter().cloned());
    }
    let mut errors = Vec::new();
    for session_id in session_ids {
        match stop_worker_container(&session_id) {
            Ok(_) => {
                if let Ok(mut sessions) = server.cluster_sessions.lock() { sessions.remove(&session_id); }
                if let Ok(mut starting) = server.starting_sessions.lock() { starting.remove(&session_id); }
            }
            Err(error) => errors.push(error),
        }
    }
    if errors.is_empty() { Ok(()) } else { Err(errors.join("; ")) }
}

pub fn reconcile_worker_sessions(accepted_request_ids: &HashSet<String>) -> Result<(), String> {
    let Some(server) = SERVER.get() else { return Ok(()); };
    let stale = server.cluster_sessions.lock().map_err(|_| "Provider session list is unavailable.".to_string())?
        .iter().filter(|(_, value)| !accepted_request_ids.contains(&value.3)).map(|(id, _)| id.clone()).collect::<Vec<_>>();
    let mut errors = Vec::new();
    for session_id in stale {
        match stop_worker_container(&session_id) {
            Ok(_) => {
                if let Ok(mut sessions) = server.cluster_sessions.lock() { sessions.remove(&session_id); }
                if let Ok(mut cancelled) = server.cancelled_sessions.lock() { cancelled.remove(&session_id); }
            }
            Err(error) => errors.push(error),
        }
    }
    if errors.is_empty() { Ok(()) } else { Err(errors.join("; ")) }
}
pub fn now_iso() -> String { chrono::Utc::now().to_rfc3339() }
