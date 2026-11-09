use base64::{engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}, Engine as _};
use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;
use std::{
    collections::HashMap,
    net::{TcpStream, ToSocketAddrs},
    process::{Command, Output, Stdio},
    path::Path,
    sync::{atomic::{AtomicBool, Ordering}, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use sysinfo::{Disks, Networks, System};

mod peer;

const AWS_REGION: &str = "ap-south-1";
const COGNITO_CLIENT_ID: &str = "794gej34ru6dce5b7bqhfu165e";
const COGNITO_TARGET: &str = "https://cognito-idp.ap-south-1.amazonaws.com/";
const COGNITO_HOSTED_LOGIN: &str = "https://ap-south-1xalbwsaws.auth.ap-south-1.amazoncognito.com/login/continue?client_id=794gej34ru6dce5b7bqhfu165e&redirect_uri=https%3A%2F%2Fd84l1y8p4kdic.cloudfront.net&response_type=code&scope=email+openid+phone";
const COGNITO_REDIRECT_URI: &str = "https://d84l1y8p4kdic.cloudfront.net";
const COGNITO_TOKEN_ENDPOINT: &str = "https://ap-south-1xalbwsaws.auth.ap-south-1.amazoncognito.com/oauth2/token";
const COMPUTEPOOL_API_URL: Option<&str> = option_env!("COMPUTEPOOL_API_URL");
static COGNITO_SESSION: OnceLock<Mutex<Option<StoredTokens>>> = OnceLock::new();
static ACTIVE_COMPUTE_SESSION: OnceLock<Mutex<Option<Value>>> = OnceLock::new();
static SESSION_PROGRESS: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();
static JOB_OUTPUT_TARGETS: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();
static JOB_OUTPUT_SYNCED: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
static CLOSE_PENDING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HardwareSnapshot {
    captured_at: String,
    cpu: CpuInfo,
    memory: MemoryInfo,
    gpus: Vec<GpuInfo>,
    storage: Vec<StorageInfo>,
    network: NetworkInfo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CpuInfo {
    model: String,
    physical_cores: usize,
    logical_cores: usize,
    utilization_percent: f32,
    frequency_mhz: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryInfo {
    total_bytes: u64,
    used_bytes: u64,
    available_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GpuInfo {
    id: String,
    name: String,
    vendor: String,
    compute_supported: bool,
    telemetry_available: bool,
    utilization_percent: f32,
    vram_total_bytes: u64,
    vram_used_bytes: u64,
    driver_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageInfo {
    name: String,
    total_bytes: u64,
    available_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkInfo {
    connected: bool,
    interface_name: Option<String>,
    netbird_status: String,
    peer_ip: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum DependencyStatus {
    Installed,
    OnDemand,
    Missing,
    Outdated,
    NotRunning,
    ConfigurationRequired,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Dependency {
    id: String,
    name: String,
    status: DependencyStatus,
    installed_version: Option<String>,
    required_version: String,
    details: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopPeer {
    id: String,
    display_name: String,
    netbird_ip: Option<String>,
    connected: bool,
    connection_type: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct KubernetesPod {
    namespace: String,
    name: String,
    phase: String,
    containers: Vec<String>,
}

#[derive(Debug, Clone)]
struct StoredTokens {
    username: String,
    display_name: Option<String>,
    access_token: String,
    id_token: String,
    refresh_token: Option<String>,
    expires_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthStatus {
    authenticated: bool,
    username: Option<String>,
    display_name: Option<String>,
    expires_at: Option<u64>,
}

fn hidden_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW: background probes should not open console windows.
    command
}

fn command_output(program: &str, args: &[&str]) -> Option<Output> {
    hidden_command(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .ok()
}

fn docker_cli_candidates() -> Vec<String> {
    let mut candidates = Vec::new();
    if let Ok(program_files) = std::env::var("ProgramFiles") { candidates.push(format!("{program_files}\\Docker\\Docker\\resources\\bin\\docker.exe")); }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") { candidates.push(format!("{local_app_data}\\Programs\\DockerDesktop\\resources\\bin\\docker.exe")); }
    candidates.extend(["docker.exe".to_string(), "docker".to_string()]);
    candidates.into_iter().filter(|candidate| !candidate.contains('\\') || Path::new(candidate).is_file()).collect()
}

fn docker_output(args: &[&str]) -> Option<Output> {
    let mut last = None;
    for cli in docker_cli_candidates() {
        let desktop_ready = hidden_command(&cli).args(["--context", "desktop-linux", "info", "--format", "{{.ServerVersion}}"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).output().ok().is_some_and(|output| output.status.success());
        let mut command = hidden_command(&cli);
        if desktop_ready { command.args(["--context", "desktop-linux"]); }
        match command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).output() {
            Ok(output) if output.status.success() => return Some(output),
            Ok(output) => last = Some(output),
            Err(_) => {}
        }
    }
    last
}

fn netbird_cli_candidates() -> Vec<String> {
    let mut candidates = vec!["C:\\Program Files\\NetBird\\netbird.exe".to_string()];
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") { candidates.push(format!("{local_app_data}\\Programs\\NetBird\\netbird.exe")); }
    candidates.extend(["netbird.exe".to_string(), "netbird".to_string()]);
    candidates.into_iter().filter(|candidate| !candidate.contains('\\') || Path::new(candidate).is_file()).collect()
}

fn netbird_output(args: &[&str]) -> Option<Output> {
    netbird_cli_candidates().iter().find_map(|candidate| command_output(candidate, args))
}

fn output_text(output: &Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    format!("{stdout}\n{stderr}").trim().to_string()
}

fn ensure_peer_firewall_access() -> Result<(), String> {
    #[cfg(not(windows))]
    { return Ok(()); }
    #[cfg(windows)]
    {
        let script = r#"
$ErrorActionPreference = 'Stop'
$tcpName = 'ComputePoolNetBirdPeerTCP'
$udpName = 'ComputePoolNetBirdPeerUDP'
if (-not (Get-NetFirewallRule -DisplayName $tcpName -ErrorAction SilentlyContinue)) {
  & netsh.exe advfirewall firewall add rule name=$tcpName dir=in action=allow protocol=TCP localport=47631,6443,10250 remoteip=100.64.0.0/10 profile=any
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
if (-not (Get-NetFirewallRule -DisplayName $udpName -ErrorAction SilentlyContinue)) {
  & netsh.exe advfirewall firewall add rule name=$udpName dir=in action=allow protocol=UDP localport=8472 remoteip=100.64.0.0/10 profile=any
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
"#;
        let utf16 = script.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>();
        let encoded = STANDARD.encode(utf16);
        let elevated = format!("$p = Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile -NonInteractive -EncodedCommand {encoded}'; exit $p.ExitCode");
        let output = command_output("powershell.exe", &["-NoProfile", "-NonInteractive", "-Command", &elevated]).ok_or("Could not start the Windows Firewall setup helper.")?;
        if !output.status.success() {
            return Err("Windows Firewall did not allow the required private NetBird ports. Approve the Windows administrator prompt and retry. ComputePool only opens TCP 47631/6443/10250 and UDP 8472 to the NetBird 100.64.0.0/10 range.".into());
        }
        Ok(())
    }
}

fn nvidia_gpu_inventory() -> Vec<GpuInfo> {
    let query = ["--query-gpu=index,name,utilization.gpu,memory.total,memory.used,driver_version", "--format=csv,noheader,nounits"];
    let mut candidates = Vec::new();
    if let Ok(system_root) = std::env::var("SystemRoot") { candidates.push(format!("{system_root}\\System32\\nvidia-smi.exe")); }
    if let Ok(program_files) = std::env::var("ProgramFiles") { candidates.push(format!("{program_files}\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe")); }
    candidates.extend(["nvidia-smi.exe".into(), "nvidia-smi".into()]);
    let output = candidates.into_iter()
        .filter(|candidate| !candidate.contains('\\') || Path::new(candidate).is_file())
        .find_map(|candidate| command_output(&candidate, &query).filter(|output| output.status.success()));
    output.map(|output| String::from_utf8_lossy(&output.stdout).lines().filter_map(|line| {
        let parts = line.split(',').map(str::trim).collect::<Vec<_>>();
        if parts.len() < 6 { return None; }
        Some(GpuInfo {
            id: format!("nvidia-{}", parts[0]),
            name: parts[1].to_string(),
            vendor: "NVIDIA".into(),
            // NVIDIA is detectable, but this build does not install/configure the
            // K3s device plugin required before pods can schedule GPU workloads.
            compute_supported: false,
            telemetry_available: true,
            utilization_percent: parts[2].parse().unwrap_or(0.0),
            vram_total_bytes: parts[3].parse::<u64>().unwrap_or(0).saturating_mul(1024 * 1024),
            vram_used_bytes: parts[4].parse::<u64>().unwrap_or(0).saturating_mul(1024 * 1024),
            driver_version: Some(parts[5].to_string()),
        })
    }).collect()).unwrap_or_default()
}

fn windows_display_adapters() -> Vec<GpuInfo> {
    #[cfg(not(windows))]
    { return Vec::new(); }
    #[cfg(windows)]
    {
        let script = "$ErrorActionPreference='SilentlyContinue'; $adapters=@(Get-CimInstance -ClassName Win32_VideoController | Select-Object Name,PNPDeviceID,DriverVersion,AdapterRAM); ConvertTo-Json -InputObject $adapters -Compress -Depth 3";
        let output = command_output("powershell.exe", &["-NoProfile", "-NonInteractive", "-Command", script])
            .filter(|output| output.status.success());
        let Some(output) = output else { return Vec::new(); };
        let Ok(value) = serde_json::from_slice::<Value>(&output.stdout) else { return Vec::new(); };
        let rows = value.as_array().cloned().unwrap_or_else(|| vec![value]);
        rows.into_iter().filter_map(|row| {
            let name = row.get("Name")?.as_str()?.trim();
            if name.is_empty() || name.to_lowercase().contains("microsoft basic render") { return None; }
            let pnp = row.get("PNPDeviceID").and_then(Value::as_str).unwrap_or_default();
            let lower = format!("{name} {pnp}").to_lowercase();
            let vendor = if lower.contains("nvidia") || lower.contains("ven_10de") { "NVIDIA" }
                else if lower.contains("amd") || lower.contains("radeon") || lower.contains("ven_1002") { "AMD" }
                else if lower.contains("intel") || lower.contains("ven_8086") { "Intel" }
                else { "Unknown" };
            let digest = Sha256::digest(if pnp.is_empty() { name.as_bytes() } else { pnp.as_bytes() });
            let stable_id = digest[..6].iter().map(|byte| format!("{byte:02x}")).collect::<String>();
            let adapter_ram = row.get("AdapterRAM").and_then(Value::as_u64).unwrap_or(0);
            let driver = row.get("DriverVersion").and_then(Value::as_str).filter(|value| !value.is_empty()).map(ToOwned::to_owned);
            Some(GpuInfo {
                id: if vendor == "NVIDIA" { format!("nvidia-wmi-{stable_id}") } else { format!("display-{stable_id}") },
                name: name.to_string(),
                vendor: vendor.into(),
                compute_supported: false,
                telemetry_available: false,
                utilization_percent: 0.0,
                vram_total_bytes: if vendor == "AMD" { 0 } else { adapter_ram },
                vram_used_bytes: 0,
                driver_version: driver,
            })
        }).collect()
    }
}

fn detect_gpus() -> Vec<GpuInfo> {
    let nvidia = nvidia_gpu_inventory();
    let mut adapters = windows_display_adapters();
    let mut result = Vec::new();
    for adapter in adapters.drain(..) {
        if adapter.vendor == "NVIDIA" {
            if let Some(measured) = nvidia.iter().find(|gpu| gpu.name.eq_ignore_ascii_case(&adapter.name)) {
                result.push(measured.clone());
                continue;
            }
        }
        result.push(adapter);
    }
    for gpu in nvidia {
        if !result.iter().any(|existing| existing.name.eq_ignore_ascii_case(&gpu.name)) { result.push(gpu); }
    }
    result
}

fn version_from_text(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    for start in 0..bytes.len() {
        if !bytes[start].is_ascii_digit() {
            continue;
        }
        let mut end = start;
        while end < bytes.len() && (bytes[end].is_ascii_digit() || bytes[end] == b'.') {
            end += 1;
        }
        let candidate = &text[start..end];
        if candidate.contains('.') && candidate.trim_matches('.').split('.').count() >= 2 {
            return Some(candidate.trim_matches('.').to_string());
        }
    }
    None
}

fn version_at_least(found: &str, required: &str) -> bool {
    let parse = |value: &str| -> Vec<u64> {
        value.split('.').filter_map(|part| part.parse::<u64>().ok()).collect()
    };
    let a = parse(found);
    let b = parse(required);
    if a.is_empty() || b.is_empty() {
        return true;
    }
    for i in 0..a.len().max(b.len()) {
        let av = *a.get(i).unwrap_or(&0);
        let bv = *b.get(i).unwrap_or(&0);
        if av != bv {
            return av > bv;
        }
    }
    true
}

fn make_dependency(id: &str, name: &str, required: &str, output: Option<Output>, details: Option<&str>) -> Dependency {
    let (status, installed_version) = match output {
        None => (DependencyStatus::Missing, None),
        Some(out) if !out.status.success() => (DependencyStatus::Missing, None),
        Some(out) => {
            let text = output_text(&out);
            let version = version_from_text(&text);
            let status = match version.as_deref() {
                Some(v) if !version_at_least(v, required) => DependencyStatus::Outdated,
                _ => DependencyStatus::Installed,
            };
            (status, version)
        }
    };
    Dependency {
        id: id.to_string(),
        name: name.to_string(),
        status,
        installed_version,
        required_version: required.to_string(),
        details: details.map(ToOwned::to_owned),
    }
}

fn netbird_status_json() -> Option<Value> {
    let output = netbird_output(&["status", "--json"])?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

fn netbird_connected(value: &Value) -> bool {
    value
        .pointer("/management/connected")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn nested_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str).map(ToOwned::to_owned))
}

fn local_peer_ip(status: &Value) -> Option<String> {
    nested_string(status, &["netbirdIp", "netbird_ip", "ip"])
        .or_else(|| netbird_output(&["status", "--ipv4"])
            .filter(|output| output.status.success())
            .map(|output| output_text(&output).trim().to_string()))
        .and_then(|value| value.split('/').next().map(str::to_string))
        .and_then(|value| value.parse::<std::net::IpAddr>().ok().map(|ip| ip.to_string()))
}

#[tauri::command]
async fn get_hardware() -> Result<HardwareSnapshot, String> {
    let mut sys = System::new_all();
    sys.refresh_cpu_all();
    std::thread::sleep(Duration::from_millis(250));
    sys.refresh_cpu_all();
    sys.refresh_memory();

    let cpu = sys.cpus().first();
    let logical_cores = sys.cpus().len();
    let physical_cores = System::physical_core_count().unwrap_or(logical_cores);
    let cpu_info = CpuInfo {
        model: cpu.map(|c| c.brand().trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "Unknown processor".into()),
        physical_cores,
        logical_cores,
        utilization_percent: sys.global_cpu_usage(),
        frequency_mhz: cpu.map(|c| c.frequency()).unwrap_or(0),
    };
    let memory = MemoryInfo {
        total_bytes: sys.total_memory(),
        used_bytes: sys.used_memory(),
        available_bytes: sys.available_memory(),
    };

    let gpus = detect_gpus();

    let storage = Disks::new_with_refreshed_list()
        .iter()
        .map(|disk| StorageInfo {
            name: disk.name().to_string_lossy().to_string(),
            total_bytes: disk.total_space(),
            available_bytes: disk.available_space(),
        })
        .collect::<Vec<_>>();
    let networks = Networks::new_with_refreshed_list();
    let interface_name = networks.keys().find(|name| !name.to_lowercase().contains("loopback")).cloned();
    let netbird = netbird_status_json();
    let status_text = netbird.as_ref().map(|v| v.to_string().to_lowercase()).unwrap_or_default();
    let netbird_status = if netbird.as_ref().is_some_and(netbird_connected) {
        "connected"
    } else if status_text.contains("connecting") {
        "starting"
    } else if netbird.is_some() {
        "disconnected"
    } else {
        "unknown"
    };
    let connected = "api.netbird.io:443"
        .to_socket_addrs()
        .ok()
        .and_then(|mut addresses| addresses.next())
        .is_some_and(|address| TcpStream::connect_timeout(&address, Duration::from_millis(900)).is_ok());

    Ok(HardwareSnapshot {
        captured_at: chrono_timestamp(),
        cpu: cpu_info,
        memory,
        gpus,
        storage,
        network: NetworkInfo {
            connected,
            interface_name,
            netbird_status: netbird_status.to_string(),
            peer_ip: netbird.as_ref().and_then(local_peer_ip),
        },
    })
}

fn chrono_timestamp() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[tauri::command]
async fn check_dependencies() -> Result<Vec<Dependency>, String> {
    let docker_cli = docker_output(&["--version"]);
    let docker_server = docker_output(&["info", "--format", "{{.ServerVersion}}"]);
    let docker = match (docker_cli, docker_server) {
        (_, Some(server)) if server.status.success() => {
            let mut dependency = make_dependency("docker", "Docker Desktop engine", "24.0", Some(server), None);
            dependency.details = Some("Docker Desktop engine is responding. ComputePool prefers its desktop-linux context and falls back to the active Docker context.".into());
            dependency
        }
        (Some(cli), _) if cli.status.success() => Dependency { id: "docker".into(), name: "Docker Desktop engine".into(), status: DependencyStatus::NotRunning, installed_version: version_from_text(&output_text(&cli)), required_version: "24.0".into(), details: Some("Docker CLI is installed, but no Docker Engine answered. Open Docker Desktop, wait for Engine running, then refresh diagnostics.".into()) },
        _ => Dependency { id: "docker".into(), name: "Docker Desktop engine".into(), status: DependencyStatus::Missing, installed_version: None, required_version: "24.0".into(), details: Some("Docker CLI was not found on PATH or in the standard Docker Desktop install folders.".into()) },
    };

    let image = docker_output(&["image", "inspect", K3S_IMAGE, "--format", "{{.Id}}"]);
    let running = docker_output(&["inspect", K3S_SERVER_CONTAINER, "--format", "{{.State.Running}}|{{.Config.Image}}"]);
    let k3s = if running.as_ref().is_some_and(|o| o.status.success() && output_text(o).starts_with("true|")) {
        Dependency { id: "k3s".into(), name: "K3s cluster runtime".into(), status: DependencyStatus::Installed, installed_version: Some("running in Docker".into()), required_version: "1.31".into(), details: Some("The ComputePool K3s server container is currently running.".into()) }
    } else if image.as_ref().is_some_and(|o| o.status.success()) {
        Dependency { id: "k3s".into(), name: "K3s cluster runtime".into(), status: DependencyStatus::Installed, installed_version: Some("Docker image cached".into()), required_version: "1.31".into(), details: Some("K3s is supplied as a Docker image. ComputePool creates the cluster when you start a session.".into()) }
    } else {
        Dependency { id: "k3s".into(), name: "K3s cluster runtime".into(), status: DependencyStatus::OnDemand, installed_version: None, required_version: "1.31".into(), details: Some("No separate Windows or WSL K3s install is needed. ComputePool pulls the K3s image through Docker Desktop when the first session starts.".into()) }
    };

    let netbird_version = netbird_output(&["version"]);
    let netbird = if let Some(version) = netbird_version.filter(|o| o.status.success()) {
        let installed_version = version_from_text(&output_text(&version));
        match get_netbird_status().await {
            Ok(status) if status.get("connected").and_then(Value::as_bool) == Some(true) => Dependency { id: "netbird".into(), name: "NetBird".into(), status: DependencyStatus::Installed, installed_version, required_version: "0.27".into(), details: Some(format!("Connected · peer IP {}", status.get("peerIp").and_then(Value::as_str).unwrap_or("not reported"))) },
            Ok(_) => Dependency { id: "netbird".into(), name: "NetBird".into(), status: DependencyStatus::ConfigurationRequired, installed_version, required_version: "0.27".into(), details: Some("Installed, but not enrolled yet. ComputePool enrolls this laptop automatically when you connect or go online.".into()) },
            Err(error) => Dependency { id: "netbird".into(), name: "NetBird".into(), status: DependencyStatus::NotRunning, installed_version, required_version: "0.27".into(), details: Some(error) },
        }
    } else {
        Dependency { id: "netbird".into(), name: "NetBird".into(), status: DependencyStatus::Missing, installed_version: None, required_version: "0.27".into(), details: Some("Install the official NetBird Windows client. ComputePool enrolls it automatically after installation.".into()) }
    };

    Ok(vec![docker, k3s, netbird])
}

#[tauri::command]
async fn verify_dependency(id: String) -> Result<Dependency, String> {
    check_dependencies().await?.into_iter().find(|dep| dep.id == id).ok_or_else(|| format!("Unknown dependency: {id}"))
}

#[tauri::command]
async fn install_dependency(id: String) -> Result<Value, String> {
    let before = verify_dependency(id.clone()).await?;
    if matches!(before.status, DependencyStatus::Installed) {
        return Ok(json!({ "status": "installed", "installedVersion": before.installed_version }));
    }
    if id == "k3s" {
        let output = docker_output(&["pull", K3S_IMAGE]).ok_or_else(|| "Could not download the K3s image. Make sure Docker Desktop is running and its Linux engine is available.".to_string())?;
        if !output.status.success() { return Err(format!("K3s image download failed: {}", output_text(&output))); }
        let after = verify_dependency("k3s".into()).await?;
        return Ok(json!({ "status": after.status, "installedVersion": after.installed_version, "details": after.details }));
    }
    if id == "docker" && matches!(before.status, DependencyStatus::NotRunning) {
        let mut candidates = Vec::new();
        if let Ok(program_files) = std::env::var("ProgramFiles") { candidates.push(format!("{program_files}\\Docker\\Docker\\Docker Desktop.exe")); }
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") { candidates.push(format!("{local_app_data}\\Docker\\Docker Desktop.exe")); }
        if let Some(app) = candidates.into_iter().find(|path| Path::new(path).is_file()) {
            hidden_command(&app).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| format!("Could not start Docker Desktop: {e}"))?;
            return Ok(json!({ "status": "not_running", "details": "Docker Desktop is starting. Status will update automatically when its engine responds." }));
        }
        return Err("Docker CLI is present, but Docker Desktop.exe was not found in its standard install location. Start Docker Desktop from the Windows Start menu, then refresh status.".into());
    }
    let (program, args): (&str, &[&str]) = match id.as_str() {
        "docker" => ("winget.exe", &["install", "--id", "Docker.DockerDesktop", "--exact", "--accept-package-agreements", "--accept-source-agreements"]),
        "netbird" => ("winget.exe", &["install", "--id", "Netbird.Netbird", "--exact", "--accept-package-agreements", "--accept-source-agreements"]),
        _ => return Err(format!("No approved installer is configured for {id}.")),
    };
    let output = hidden_command(program).args(args).stdin(Stdio::null()).output().map_err(|e| format!("Could not start installer: {e}"))?;
    if !output.status.success() {
        return Err(format!("Installer exited with {}: {}", output.status, output_text(&output)));
    }
    let after = verify_dependency(id).await?;
    Ok(json!({ "status": after.status, "installedVersion": after.installed_version, "details": after.details }))
}

#[tauri::command]
async fn get_netbird_status() -> Result<Value, String> {
    let version = netbird_output(&["version"]);
    let status_output = netbird_output(&["status", "--json"]);
    let Some(status_output) = status_output else {
        return Ok(json!({ "installed": version.is_some(), "connected": false, "status": if version.is_some() { "not_running" } else { "missing" }, "version": version.and_then(|o| version_from_text(&output_text(&o))), "peerIp": null }));
    };
    if !status_output.status.success() {
        return Ok(json!({ "installed": true, "connected": false, "status": "not_running", "version": version.and_then(|o| version_from_text(&output_text(&o))), "peerIp": null }));
    }
    let parsed: Value = serde_json::from_slice(&status_output.stdout).map_err(|e| format!("NetBird returned invalid JSON status: {e}"))?;
    Ok(json!({ "installed": true, "connected": netbird_connected(&parsed), "status": if netbird_connected(&parsed) { "connected" } else { "disconnected" }, "version": version.and_then(|o| version_from_text(&output_text(&o))), "peerIp": local_peer_ip(&parsed), "raw": parsed }))
}

#[tauri::command]
async fn connect_netbird(role: Option<String>) -> Result<(), String> {
    let role = role.as_deref().unwrap_or("consumer");
    ensure_netbird_connected(role).await.map(|_| ())
}

#[tauri::command]
async fn list_netbird_peers() -> Result<Vec<DesktopPeer>, String> {
    let output = netbird_output(&["status", "--json"]).ok_or_else(|| "NetBird is not installed on this machine or its service is unavailable.".to_string())?;
    if !output.status.success() { return Err(format!("NetBird daemon is unavailable: {}", output_text(&output))); }
    let status: Value = serde_json::from_slice(&output.stdout).map_err(|e| format!("Could not parse NetBird peer status: {e}"))?;
    let list = status.pointer("/peers/details").and_then(Value::as_array).or_else(|| status.get("peers").and_then(Value::as_array)).or_else(|| status.pointer("/management/peers").and_then(Value::as_array)).cloned().unwrap_or_default();
    Ok(list.into_iter().filter_map(|peer| {
        let id = nested_string(&peer, &["id", "publicKey", "fqdn", "ip"])?;
        let display_name = nested_string(&peer, &["fqdn", "name", "hostname"]).unwrap_or_else(|| id.clone());
        let raw_status = nested_string(&peer, &["status", "connectionState", "connection_state"]).unwrap_or_default().to_lowercase();
        let connected = raw_status.contains("connected") && !raw_status.contains("disconnected");
        Some(DesktopPeer {
            id,
            display_name,
            netbird_ip: nested_string(&peer, &["ip", "netbirdIp", "netbird_ip"]),
            connected,
            connection_type: nested_string(&peer, &["connectionType", "connection_type", "connType"]),
        })
    }).collect())
}

fn netbird_binary() -> Result<String, String> {
    netbird_cli_candidates().into_iter().find(|candidate| command_output(candidate, &["version"]).is_some_and(|output| output.status.success())).ok_or_else(|| "NetBird CLI is not installed.".into())
}

const COMPUTEPOOL_NETBIRD_PROFILE: &str = "computepool";

fn ensure_computepool_netbird_profile(program: &str) -> Result<(), String> {
    let list = command_output(program, &["profile", "list", "--show-id"])
        .filter(|output| output.status.success())
        .ok_or_else(|| "This NetBird client does not support separate profiles. Update NetBird, then retry; ComputePool keeps your existing NetBird identity untouched.".to_string())?;
    let listing = output_text(&list);
    let profile_line = listing.lines().find(|line| {
        line.split_whitespace().any(|part| part.eq_ignore_ascii_case(COMPUTEPOOL_NETBIRD_PROFILE))
    });

    if let Some(line) = profile_line {
        let active = line.contains('✓') || line.split_whitespace().last().is_some_and(|part| part == "*");
        if !active {
            let selected = command_output(program, &["profile", "select", COMPUTEPOOL_NETBIRD_PROFILE]);
            if !selected.as_ref().is_some_and(|output| output.status.success()) {
                return Err(format!("Could not select ComputePool's NetBird profile: {}", selected.as_ref().map(output_text).unwrap_or_else(|| "NetBird CLI could not start.".into())));
            }
        }
        return Ok(());
    }

    let added = command_output(program, &["profile", "add", COMPUTEPOOL_NETBIRD_PROFILE]);
    if !added.as_ref().is_some_and(|output| output.status.success()) {
        return Err(format!("Could not create ComputePool's separate NetBird profile: {}", added.as_ref().map(output_text).unwrap_or_else(|| "NetBird CLI could not start.".into())));
    }
    let selected = command_output(program, &["profile", "select", COMPUTEPOOL_NETBIRD_PROFILE]);
    if !selected.as_ref().is_some_and(|output| output.status.success()) {
        return Err(format!("Could not activate ComputePool's separate NetBird profile: {}", selected.as_ref().map(output_text).unwrap_or_else(|| "NetBird CLI could not start.".into())));
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn open_node_shell(cluster_id: String, node_id: String) -> Result<Value, String> {
    let active = ACTIVE_COMPUTE_SESSION.get_or_init(|| Mutex::new(None)).lock().map_err(|_| "Session state is unavailable.")?.clone().ok_or("Start a shared ComputePool session before opening a provider shell.")?;
    if cluster_id != SHARED_CLUSTER_ID || active.get("clusterId").and_then(Value::as_str) != Some(cluster_id.as_str()) {
        return Err("Provider machine shell is available only for a connected ComputePool session.".into());
    }
    let provider_session = active.get("providers").and_then(Value::as_array).into_iter().flatten().find(|item| item.get("node").and_then(Value::as_str) == Some(node_id.as_str())).ok_or("That node is not part of the active session.")?;
    let provider = provider_session.get("provider").cloned().ok_or("Provider connection details are missing.")?;
    let session_id = active.get("sessionId").and_then(Value::as_str).ok_or("Session ID is missing.")?;
    let id_token = current_id_token().await?;
    let result = peer::remote_service_action(&provider, &id_token, "cluster/node/exec", json!({"sessionId": session_id, "command": "whoami"})).await?;
    if result.get("exitCode").and_then(Value::as_i64).unwrap_or(-1) != 0 {
        return Err(result.get("stderr").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("Provider shell health check failed.").to_string());
    }
    let peer_name = provider.get("displayName").and_then(Value::as_str).unwrap_or("Provider node");
    let peer_ip = provider.get("netbirdIp").and_then(Value::as_str).unwrap_or("");
    let shell_id = format!("{session_id}:{}", node_id);
    Ok(json!({"shellId": shell_id, "peerName": peer_name, "peerIp": peer_ip, "stdout": result.get("stdout").cloned().unwrap_or(json!(""))}))
}

#[tauri::command]
async fn execute_node_shell_command(shell_id: String, command: String) -> Result<Value, String> {
    if command.trim().is_empty() { return Err("Enter a command.".into()); }
    if command.len() > 16_000 { return Err("Provider shell commands are limited to 16000 characters.".into()); }
    let (session_id, node_id) = shell_id.split_once(':').ok_or("Invalid provider shell session.")?;
    let active = ACTIVE_COMPUTE_SESSION.get_or_init(|| Mutex::new(None)).lock().map_err(|_| "Session state is unavailable.")?.clone().ok_or("The compute session has ended.")?;
    if active.get("sessionId").and_then(Value::as_str) != Some(session_id) { return Err("The provider shell is no longer attached to the active session.".into()); }
    let provider_session = active.get("providers").and_then(Value::as_array).into_iter().flatten().find(|item| item.get("node").and_then(Value::as_str) == Some(node_id)).ok_or("That provider node is not part of the active session.")?;
    let provider = provider_session.get("provider").cloned().ok_or("Provider connection details are missing.")?;
    let id_token = current_id_token().await?;
    peer::remote_service_action(&provider, &id_token, "cluster/node/exec", json!({"sessionId": session_id, "command": command.trim()})).await
}

#[tauri::command]
async fn list_running_pods(cluster_id: String) -> Result<Vec<KubernetesPod>, String> {
    let args = ["get", "pods", "--all-namespaces", "-o", "json"];
    let output = cluster_output(&cluster_id, &args).ok_or_else(|| "kubectl is not installed or not on PATH.".to_string())?;
    if !output.status.success() { return Err(format!("Could not list Kubernetes pods: {}", output_text(&output))); }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|e| format!("kubectl returned invalid pod JSON: {e}"))?;
    Ok(value.pointer("/items").and_then(Value::as_array).into_iter().flatten().filter_map(|pod| {
        let metadata = pod.get("metadata")?;
        let status = pod.get("status")?;
        Some(KubernetesPod { namespace: metadata.get("namespace")?.as_str()?.to_string(), name: metadata.get("name")?.as_str()?.to_string(), phase: status.get("phase")?.as_str()?.to_string(), containers: pod.pointer("/spec/containers").and_then(Value::as_array).into_iter().flatten().filter_map(|c| c.get("name").and_then(Value::as_str).map(ToOwned::to_owned)).collect() })
    }).filter(|pod| pod.phase == "Running").collect())
}

fn cluster_gpu_capacity(cluster_id: &str, selected_nodes: Option<&[String]>) -> Result<u32, String> {
    let output = cluster_output(cluster_id, &["get", "nodes", "-o", "json"]).ok_or("Docker or kubectl could not query the active cluster.")?;
    if !output.status.success() { return Err(format!("Could not inspect K3s GPU capacity: {}", output_text(&output))); }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|e| format!("K3s returned invalid node data: {e}"))?;
    Ok(value.get("items").and_then(Value::as_array).into_iter().flatten().filter(|node| {
        let ready = node.pointer("/status/conditions").and_then(Value::as_array).into_iter().flatten().any(|condition| condition.get("type").and_then(Value::as_str) == Some("Ready") && condition.get("status").and_then(Value::as_str) == Some("True"));
        let name = node.pointer("/metadata/name").and_then(Value::as_str).unwrap_or_default();
        ready && selected_nodes.is_none_or(|selected| selected.iter().any(|candidate| candidate == name))
    }).map(|node| node.pointer("/status/allocatable/nvidia.com~1gpu").and_then(Value::as_str).and_then(|count| count.parse::<u32>().ok()).unwrap_or(0)).sum())
}

#[tauri::command(rename_all = "camelCase")]
async fn create_interactive_pod(cluster_id: String, image: String, cpu_cores: u32, memory_gib: u32, gpu_count: u32, namespace: String) -> Result<Value, String> {
    if cluster_id != SHARED_CLUSTER_ID || ACTIVE_COMPUTE_SESSION.get_or_init(|| Mutex::new(None)).lock().map_err(|_| "Session state is unavailable.")?.is_none() {
        return Err("Start a connected ComputePool cluster before creating a pod.".into());
    }
    if image.trim().is_empty() || image.chars().any(char::is_whitespace) { return Err("Enter a valid container image reference.".into()); }
    if cpu_cores == 0 || memory_gib == 0 || cpu_cores > 256 || memory_gib > 4096 || gpu_count > 32 { return Err("Requested resources are outside the supported range.".into()); }
    if namespace.is_empty() || namespace.len() > 63 || !namespace.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') || !namespace.as_bytes()[0].is_ascii_alphanumeric() || !namespace.as_bytes()[namespace.len() - 1].is_ascii_alphanumeric() { return Err("Namespace must be a Kubernetes name: 1–63 lowercase letters, digits, or hyphens, starting and ending with a letter or digit.".into()); }
    if gpu_count > 0 && cluster_gpu_capacity(&cluster_id, None)? < gpu_count {
        return Err("This active cluster does not advertise enough schedulable NVIDIA GPUs. GPU display adapters are detected locally, but K3s GPU device-plugin scheduling is not configured in this build.".into());
    }
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let pod_name = format!("cp-shell-{stamp}");
    let mut requests = json!({"cpu": cpu_cores.to_string(), "memory": format!("{memory_gib}Gi")});
    let mut limits = requests.clone();
    if gpu_count > 0 {
        requests["nvidia.com/gpu"] = json!(gpu_count.to_string());
        limits["nvidia.com/gpu"] = json!(gpu_count.to_string());
    }
    let pod_spec = json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {"name": pod_name, "namespace": namespace, "labels": {"app.kubernetes.io/managed-by": "computepool", "computepool.io/role": "interactive-shell"}},
        "spec": {
            "restartPolicy": "Never",
            "containers": [{
                "name": "shell",
                "image": image.trim(),
                "imagePullPolicy": if image.trim().ends_with(":latest") || !image.trim().contains(':') { "Always" } else { "IfNotPresent" },
                "command": ["/bin/sh", "-lc", "sleep infinity"],
                "resources": {"requests": requests, "limits": limits}
            }]
        }
    });
    let manifest = serde_json::to_vec(&pod_spec).map_err(|error| format!("Could not encode the pod specification: {error}"))?;
    let output = kubectl_with_input(&["create", "-f", "-"], &manifest)?;
    if !output.status.success() { return Err(format!("Could not create the interactive pod: {}", output_text(&output))); }
    // Return as soon as the API server accepts the pod. Image pulls can take
    // longer than a fixed kubectl wait timeout, and deleting the pod here
    // prevents kubelet's own ImagePullBackOff retry from recovering.
    Ok(json!({"namespace": namespace, "podName": pod_name, "image": image.trim(), "cpuCores": cpu_cores, "memoryGiB": memory_gib, "gpuCount": gpu_count}))
}

#[tauri::command(rename_all = "camelCase")]
async fn open_pod_shell(cluster_id: String, namespace: String, pod_name: String, container: Option<String>) -> Result<Value, String> {
    if cluster_id != SHARED_CLUSTER_ID { return Err("The selected ComputePool cluster is no longer active. Return to Session dashboard and reconnect.".into()); }
    if namespace.is_empty() || namespace.len() > 63 || !namespace.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        || pod_name.is_empty() || pod_name.len() > 63 || !pod_name.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') {
        return Err("The pod name or namespace is invalid.".into());
    }
    let mut args = vec!["exec", "--namespace", namespace.as_str(), pod_name.as_str()];
    if let Some(container) = container.as_deref() { args.extend(["--container", container]); }
    args.extend(["--", "sh", "-lc", "printf 'pod shell ready\\n'"]);
    let mut last_error = String::new();
    // Kubelet retries image pulls with exponential backoff. Keep the pod alive
    // long enough for transient registry/DNS/TLS failures to recover instead
    // of deleting it after a short startup timeout.
    for attempt in 0..60 {
        let output = cluster_output(&cluster_id, &args).ok_or_else(|| "Docker could not open the pod shell. Confirm Docker Desktop is running and the ComputePool K3s container is available.".to_string())?;
        if output.status.success() {
            return Ok(json!({"shellId": format!("pod:{cluster_id}:{namespace}:{pod_name}:{}", container.unwrap_or_default())}));
        }
        last_error = output_text(&output);
        let transient = {
            let message = last_error.to_lowercase();
            message.contains("pod does not exist") || message.contains("unable to upgrade connection")
                || message.contains("container not found") || message.contains("container is not running")
                || message.contains("connection refused") || message.contains("timed out")
                || message.contains("imagepullbackoff") || message.contains("errimagepull")
                || message.contains("containercreating") || message.contains("waiting to start")
        };
        if !transient || attempt == 59 { break; }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    let status = cluster_output(&cluster_id, &["get", "pod", "--namespace", namespace.as_str(), pod_name.as_str(), "-o", "json"])
        .filter(|output| output.status.success()).and_then(|output| serde_json::from_slice::<Value>(&output.stdout).ok()).map(|pod| {
            let phase = pod.pointer("/status/phase").and_then(Value::as_str).unwrap_or("unknown");
            let node = pod.pointer("/spec/nodeName").and_then(Value::as_str).unwrap_or("not scheduled");
            let container = pod.pointer("/status/containerStatuses/0/state/waiting");
            let reason = container.and_then(|state| state.get("reason")).and_then(Value::as_str).unwrap_or("none");
            let detail = container.and_then(|state| state.get("message")).and_then(Value::as_str).unwrap_or("");
            format!("phase={phase}, node={node}, reason={reason}{}", if detail.is_empty() { String::new() } else { format!(", detail={detail}") })
        });
    let events = cluster_output(&cluster_id, &["get", "events", "--namespace", namespace.as_str(), "--field-selector", &format!("involvedObject.name={pod_name}"), "--sort-by=.lastTimestamp"])
        .filter(|output| output.status.success()).map(|output| output_text(&output)).filter(|text| !text.is_empty());
    Err(format!("Pod {namespace}/{pod_name} is kept running its image-pull retries; the terminal is not connected yet. Last exec error: {}. Current pod: {}. Recent Kubernetes events: {}. Use Reconnect terminal after registry access recovers.", last_error.trim(), status.unwrap_or_else(|| "status unavailable".into()), events.unwrap_or_else(|| "none returned".into())))
}

#[tauri::command]
async fn execute_pod_shell_command(shell_id: String, command: String) -> Result<Value, String> {
    if command.trim().is_empty() { return Err("Enter a command.".into()); }
    let mut parts = shell_id.splitn(5, ':');
    if parts.next() != Some("pod") { return Err("Invalid Kubernetes pod shell session.".into()); }
    let cluster_id = parts.next().ok_or("Invalid Kubernetes context.")?;
    let namespace = parts.next().ok_or("Invalid pod namespace.")?;
    let pod = parts.next().ok_or("Invalid pod name.")?;
    let container = parts.next().unwrap_or("");
    let mut args = vec!["exec", "--namespace", namespace, pod];
    if !container.is_empty() { args.extend(["--container", container]); }
    args.extend(["--", "sh", "-lc", command.trim()]);
    let output = cluster_output(cluster_id, &args).ok_or_else(|| "kubectl is not installed or not on PATH.".to_string())?;
    Ok(json!({"stdout": String::from_utf8_lossy(&output.stdout), "stderr": String::from_utf8_lossy(&output.stderr), "exitCode": output.status.code().unwrap_or(-1)}))
}

async fn cognito_request(target: &str, payload: Value) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .post(COGNITO_TARGET)
        .header("Content-Type", "application/x-amz-json-1.1")
        .header("X-Amz-Target", format!("AWSCognitoIdentityProviderService.{target}"))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Could not contact Cognito in {AWS_REGION}: {e}"))?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|e| format!("Cognito returned an invalid response: {e}"))?;
    if !status.is_success() {
        let code = value.get("__type").and_then(Value::as_str).unwrap_or("CognitoError").rsplit('#').next().unwrap_or("CognitoError").split(':').next().unwrap_or("CognitoError");
        let message = value.get("message").and_then(Value::as_str).unwrap_or("Sign-in failed.");
        return Err(format!("{code}: {message}"));
    }
    Ok(value)
}

fn store_tokens(tokens: &StoredTokens) -> Result<(), String> {
    *COGNITO_SESSION.get_or_init(|| Mutex::new(None)).lock().map_err(|_| "Cognito session storage is unavailable.".to_string())? = Some(tokens.clone());
    Ok(())
}

fn load_tokens() -> Result<Option<StoredTokens>, String> {
    COGNITO_SESSION.get_or_init(|| Mutex::new(None)).lock()
        .map(|session| session.clone())
        .map_err(|_| "Cognito session storage is unavailable.".to_string())
}

fn clear_tokens() -> Result<(), String> {
    *COGNITO_SESSION.get_or_init(|| Mutex::new(None)).lock().map_err(|_| "Cognito session storage is unavailable.".to_string())? = None;
    Ok(())
}

#[tauri::command]
async fn get_auth_status() -> Result<AuthStatus, String> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let Some(mut tokens) = load_tokens()? else { return Ok(AuthStatus { authenticated: false, username: None, display_name: None, expires_at: None }); };
    if tokens.expires_at <= now + 60 {
        let Some(refresh_token) = tokens.refresh_token.clone() else { clear_tokens()?; return Ok(AuthStatus { authenticated: false, username: None, display_name: None, expires_at: None }); };
        let response = match cognito_request("InitiateAuth", json!({
            "AuthFlow": "REFRESH_TOKEN_AUTH",
            "ClientId": COGNITO_CLIENT_ID,
            "AuthParameters": { "REFRESH_TOKEN": refresh_token }
        })).await {
            Ok(response) => response,
            Err(error) if error.starts_with("NotAuthorizedException") || error.contains("Refresh Token has been revoked") => { clear_tokens()?; return Ok(AuthStatus { authenticated: false, username: None, display_name: None, expires_at: None }); },
            Err(error) => return Err(error),
        };
        let result = response.get("AuthenticationResult").ok_or("Cognito refresh did not return an authentication result.")?;
        tokens.access_token = result.get("AccessToken").and_then(Value::as_str).ok_or("Cognito refresh did not return an access token.")?.to_string();
        tokens.id_token = result.get("IdToken").and_then(Value::as_str).ok_or("Cognito refresh did not return an ID token.")?.to_string();
        let expires_in = result.get("ExpiresIn").and_then(Value::as_u64).unwrap_or(3600);
        tokens.expires_at = now + expires_in;
        store_tokens(&tokens)?;
    }
    Ok(AuthStatus { authenticated: true, username: Some(tokens.username), display_name: tokens.display_name, expires_at: Some(tokens.expires_at) })
}

#[tauri::command]
async fn open_cognito_login(app: AppHandle) -> Result<(), String> {
    if app.get_webview_window("cognito-login").is_some() {
        return Err("Cognito sign-in is already open.".into());
    }
    let mut random = [0_u8; 32];
    OsRng.fill_bytes(&mut random);
    let verifier = URL_SAFE_NO_PAD.encode(random);
    OsRng.fill_bytes(&mut random);
    let state = URL_SAFE_NO_PAD.encode(random);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut login_url = Url::parse(COGNITO_HOSTED_LOGIN).map_err(|e| format!("Cognito login URL is invalid: {e}"))?;
    login_url.query_pairs_mut().append_pair("state", &state).append_pair("code_challenge", &challenge).append_pair("code_challenge_method", "S256");

    let callback_app = app.clone();
    WebviewWindowBuilder::new(&app, "cognito-login", WebviewUrl::External(login_url))
        .title("Sign in · Amazon Cognito")
        .inner_size(520.0, 760.0)
        .center()
        .on_navigation(move |url| {
            if url.host_str() != Some("d84l1y8p4kdic.cloudfront.net") { return true; }
            let params = url.query_pairs().into_owned().collect::<std::collections::HashMap<_, _>>();
            let returned_state = params.get("state").cloned().unwrap_or_default();
            let code = params.get("code").cloned();
            let oauth_error = params.get("error_description").or_else(|| params.get("error")).cloned();
            let app = callback_app.clone();
            let verifier = verifier.clone();
            let expected_state = state.clone();
            tauri::async_runtime::spawn(async move {
                if returned_state != expected_state {
                    let _ = app.emit("cognito-auth-error", "Cognito sign-in state did not match. Please try again.");
                } else if let Some(error) = oauth_error {
                    let _ = app.emit("cognito-auth-error", error);
                } else if let Some(code) = code {
                    match redeem_cognito_code(&code, &verifier).await {
                        Ok(status) => { let _ = app.emit("cognito-auth-complete", status); }
                        Err(error) => { let _ = app.emit("cognito-auth-error", error); }
                    }
                } else {
                    let _ = app.emit("cognito-auth-error", "Cognito returned to the app without an authorization code.");
                }
                if let Some(window) = app.get_webview_window("cognito-login") { let _ = window.close(); }
            });
            false
        })
        .build()
        .map_err(|e| format!("Could not open the Cognito sign-in window: {e}"))?;
    Ok(())
}

async fn redeem_cognito_code(code: &str, verifier: &str) -> Result<AuthStatus, String> {
    let response = reqwest::Client::new()
        .post(COGNITO_TOKEN_ENDPOINT)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", COGNITO_CLIENT_ID),
            ("redirect_uri", COGNITO_REDIRECT_URI),
            ("code", code),
            ("code_verifier", verifier),
        ])
        .send().await.map_err(|e| format!("Could not exchange the Cognito login code: {e}"))?;
    let http_status = response.status();
    let value: Value = response.json().await.map_err(|e| format!("Cognito returned an invalid token response: {e}"))?;
    if !http_status.is_success() {
        let message = value.get("error_description").or_else(|| value.get("error")).and_then(Value::as_str).unwrap_or("Cognito rejected the login code.");
        return Err(format!("Cognito token exchange failed: {message}"));
    }
    let id_token = value.get("id_token").and_then(Value::as_str).ok_or("Cognito did not return an ID token.")?.to_string();
    let access_token = value.get("access_token").and_then(Value::as_str).ok_or("Cognito did not return an access token.")?.to_string();
    let claims = id_token.split('.').nth(1).ok_or("Cognito returned a malformed ID token.")?;
    let decoded = URL_SAFE_NO_PAD.decode(claims).map_err(|_| "Cognito returned a malformed ID token payload.")?;
    let claims: Value = serde_json::from_slice(&decoded).map_err(|_| "Cognito returned an invalid ID token payload.")?;
    let email = claims.get("email").and_then(Value::as_str).unwrap_or("");
    let username = if !email.is_empty() { email.to_string() } else { claims.get("cognito:username").or_else(|| claims.get("sub")).and_then(Value::as_str).unwrap_or("Cognito user").to_string() };
    let display_name = claims.get("name").or_else(|| claims.get("given_name")).or_else(|| claims.get("preferred_username")).and_then(Value::as_str).filter(|s| !s.is_empty()).map(ToOwned::to_owned)
        .or_else(|| email.split('@').next().filter(|s| !s.is_empty()).map(|s| s.replace(['.', '_', '-'], " ")))
        .or_else(|| claims.get("cognito:username").and_then(Value::as_str).filter(|s| !s.is_empty()).map(ToOwned::to_owned));
    let expires_in = value.get("expires_in").and_then(Value::as_u64).unwrap_or(3600);
    let expires_at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() + expires_in;
    let tokens = StoredTokens {
        username: username.clone(),
        display_name: display_name.clone(),
        access_token,
        id_token,
        refresh_token: value.get("refresh_token").and_then(Value::as_str).map(ToOwned::to_owned),
        expires_at,
    };
    store_tokens(&tokens)?;
    Ok(AuthStatus { authenticated: true, username: Some(username), display_name, expires_at: Some(expires_at) })
}

#[tauri::command]
async fn cognito_sign_out() -> Result<(), String> {
    let _ = peer::set_online(false, "", json!({"online": false})).await;
    if let Some(tokens) = load_tokens()? {
        let _ = cognito_request("GlobalSignOut", json!({ "AccessToken": tokens.access_token })).await;
    }
    clear_tokens()
}

async fn current_id_token() -> Result<String, String> {
    let status = get_auth_status().await?;
    if !status.authenticated { return Err("Sign in with Amazon Cognito before using the peer network.".into()); }
    load_tokens()?.map(|t| t.id_token).ok_or_else(|| "Cognito session has expired. Sign in again.".into())
}

async fn computepool_api(method: &str, path: &str, payload: Option<Value>) -> Result<Value, String> {
    let base = COMPUTEPOOL_API_URL.ok_or_else(|| "ComputePool AWS API is not configured in this build. Deploy backend/template.yaml, then rebuild with COMPUTEPOOL_API_URL set to its ApiUrl output.".to_string())?;
    let token = current_id_token().await?;
    let url = format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'));
    let client = reqwest::Client::new();
    let mut request = client.request(method.parse().map_err(|_| "Invalid API method.")?, url).bearer_auth(token).header("Accept", "application/json");
    if let Some(body) = payload { request = request.json(&body); }
    let response = request.send().await.map_err(|e| format!("Could not contact ComputePool AWS service: {e}"))?;
    let status = response.status();
    let value = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let message = value.get("message").and_then(Value::as_str).unwrap_or("ComputePool service request failed.");
        return Err(format!("{}: {message}", status.as_u16()));
    }
    Ok(value)
}

fn provider_node_id(owner_sub: &str) -> String {
    let machine = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "desktop".into()).to_lowercase();
    let safe_machine: String = machine.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).take(48).collect();
    let digest = Sha256::digest(format!("{owner_sub}:{machine}").as_bytes());
    let suffix = digest[..6].iter().map(|b| format!("{b:02x}")).collect::<String>();
    format!("cp-{safe_machine}-{suffix}")
}

async fn ensure_netbird_connected(role: &str) -> Result<Value, String> {
    let initial_status = get_netbird_status().await?;
    if initial_status.get("installed").and_then(Value::as_bool) != Some(true) {
        return Err("Install the NetBird Windows client first. After installation, ComputePool will enroll this laptop automatically; no separate NetBird account sign-in is needed.".into());
    }
    let program = netbird_binary()?;
    ensure_computepool_netbird_profile(&program)?;
    let status = get_netbird_status().await?;
    if status.get("connected").and_then(Value::as_bool) == Some(true) {
        let ip = status.get("peerIp").and_then(Value::as_str).unwrap_or_default();
        let verification = computepool_api("POST", "/netbird/verify-peer", Some(json!({"ip": ip}))).await?;
        if verification.get("enrolled").and_then(Value::as_bool) == Some(true) { return Ok(status); }
        return Err(format!("ComputePool's NetBird profile is connected as {}, but that peer is not registered in the workspace configured for ComputePool. Check that the backend NETBIRD_MANAGEMENT_TOKEN belongs to the NetBird team shown in your dashboard. Your other NetBird profile was left unchanged.", ip));
    }
    let enrollment = computepool_api("POST", "/netbird/setup-key", Some(json!({"role": if role == "provider" {"provider"} else {"consumer"}}))).await?;
    let setup_key = enrollment.get("setupKey").and_then(Value::as_str).ok_or("ComputePool did not receive a NetBird enrollment key.")?;
    let output = hidden_command(&program).args(["up", "--setup-key", setup_key, "--profile", COMPUTEPOOL_NETBIRD_PROFILE]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).output().map_err(|e| format!("Could not enroll this laptop in the ComputePool NetBird network: {e}"))?;
    if !output.status.success() { return Err(format!("NetBird enrollment failed for ComputePool's separate profile: {}. The existing NetBird profile was not changed.", output_text(&output))); }
    for _ in 0..45 {
        let status = get_netbird_status().await?;
        if status.get("connected").and_then(Value::as_bool) == Some(true) {
            let Some(peer_ip) = status.get("peerIp").and_then(Value::as_str) else {
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            };
            let verification = computepool_api("POST", "/netbird/verify-peer", Some(json!({"ip": peer_ip}))).await?;
            if verification.get("enrolled").and_then(Value::as_bool) == Some(true) { return Ok(status); }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    Err("ComputePool's NetBird profile did not appear as a connected peer in the configured workspace within 45 seconds. Check that setup-key peer approval is disabled and that the backend NETBIRD_MANAGEMENT_TOKEN belongs to the intended workspace, then retry.".into())
}

fn current_identity_claims() -> Result<Value, String> {
    let token = load_tokens()?.ok_or("Sign in with Amazon Cognito before sharing this laptop.")?.id_token;
    let payload = token.split('.').nth(1).ok_or("Cognito returned a malformed ID token.")?;
    let decoded = URL_SAFE_NO_PAD.decode(payload).map_err(|_| "Cognito returned a malformed ID token payload.")?;
    serde_json::from_slice(&decoded).map_err(|_| "Cognito returned an invalid ID token payload.".into())
}

#[tauri::command]
async fn list_available_providers() -> Result<Vec<Value>, String> {
    let value = computepool_api("GET", "/providers", None).await?;
    value.as_array().cloned().ok_or_else(|| "ComputePool provider directory returned invalid data.".into())
}

#[tauri::command(rename_all = "camelCase")]
async fn get_provider_details(provider_id: String) -> Result<Value, String> {
    list_available_providers().await?.into_iter().find(|profile| profile.get("id").and_then(Value::as_str) == Some(provider_id.as_str())).ok_or_else(|| "That provider is not currently available in the ComputePool directory.".into())
}

#[tauri::command]
async fn list_negotiations() -> Result<Vec<Value>, String> {
    let value = computepool_api("GET", "/negotiations", None).await?;
    let sub = current_identity_claims()?.get("sub").and_then(Value::as_str).unwrap_or_default().to_string();
    let items = value.as_array().cloned().ok_or_else(|| "ComputePool negotiation service returned invalid data.".to_string())?;
    Ok(items.into_iter().map(|mut item| {
        let role = if item.get("providerSub").and_then(Value::as_str) == Some(sub.as_str()) { "provider" } else { "consumer" };
        if let Some(object) = item.as_object_mut() { object.insert("myRole".into(), json!(role)); }
        item
    }).collect())
}

#[tauri::command(rename_all = "camelCase")]
async fn get_negotiation_messages(provider_id: String) -> Result<Vec<Value>, String> {
    let items = list_negotiations().await?;
    let item = items.iter().find(|n| n.get("providerId").and_then(Value::as_str) == Some(provider_id.as_str()) && n.get("consumerSub").is_some()).ok_or("Start a resource proposal before opening this conversation.")?;
    let id = item.get("id").and_then(Value::as_str).ok_or("Negotiation ID is missing.")?;
    let value = computepool_api("GET", &format!("/negotiations/{id}/messages"), None).await?;
    value.as_array().cloned().ok_or_else(|| "ComputePool message service returned invalid data.".into())
}

#[tauri::command(rename_all = "camelCase")]
async fn get_negotiation_messages_by_id(negotiation_id: String) -> Result<Vec<Value>, String> {
    if negotiation_id.is_empty() || negotiation_id.len() > 100 || !negotiation_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Negotiation ID is invalid.".into());
    }
    let value = computepool_api("GET", &format!("/negotiations/{negotiation_id}/messages"), None).await?;
    value.as_array().cloned().ok_or_else(|| "ComputePool message service returned invalid data.".into())
}

#[tauri::command(rename_all = "camelCase")]
async fn send_negotiation_message_by_id(negotiation_id: String, body: String) -> Result<Value, String> {
    if negotiation_id.is_empty() || negotiation_id.len() > 100 || !negotiation_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Negotiation ID is invalid.".into());
    }
    computepool_api("POST", &format!("/negotiations/{negotiation_id}/messages"), Some(json!({"text": body}))).await
}

#[tauri::command(rename_all = "camelCase")]
async fn send_negotiation_message(provider_id: String, body: String) -> Result<(), String> {
    let items = list_negotiations().await?;
    let item = items.iter().find(|n| n.get("providerId").and_then(Value::as_str) == Some(provider_id.as_str()) && n.get("consumerSub").is_some()).ok_or("Send a resource proposal to start a conversation.")?;
    let id = item.get("id").and_then(Value::as_str).ok_or("Negotiation ID is missing.")?;
    let _ = computepool_api("POST", &format!("/negotiations/{id}/messages"), Some(json!({"text": body}))).await?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn send_resource_proposal(provider_id: String, limits: Value, duration_minutes: u32) -> Result<Value, String> {
    computepool_api("POST", "/negotiations", Some(json!({ "providerId": provider_id, "limits": limits, "durationMinutes": duration_minutes }))).await
}

#[tauri::command(rename_all = "camelCase")]
async fn start_resource_request(provider_id: String, limits: Value, duration_minutes: u32) -> Result<Value, String> {
    send_resource_proposal(provider_id, limits, duration_minutes).await
}

#[tauri::command(rename_all = "camelCase")]
async fn decide_resource_proposal(message_id: String, decision: String) -> Result<(), String> {
    if decision != "accept" && decision != "reject" { return Err("Choose accept or reject.".into()); }
    let _ = computepool_api("POST", &format!("/negotiations/{message_id}/decision"), Some(json!({"decision": decision}))).await?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn close_negotiation_request(negotiation_id: String) -> Result<(), String> {
    if negotiation_id.is_empty() || negotiation_id.len() > 100 || !negotiation_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Negotiation ID is invalid.".into());
    }
    let request_is_in_active_session = {
        let active = ACTIVE_COMPUTE_SESSION.get_or_init(|| Mutex::new(None)).lock().map_err(|_| "Session state is unavailable.")?;
        active.as_ref().and_then(|state| state.get("negotiationIds")).and_then(Value::as_array).is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(negotiation_id.as_str())))
    };
    if request_is_in_active_session {
        return Err("This request is part of the connected cluster. End the session from Session dashboard before closing the request.".into());
    }
    // The marketplace service verifies that this Cognito identity is the
    // consumer, removes any temporary NetBird access, and marks the request
    // ended. That releases the provider for a fresh proposal.
    let _ = computepool_api("DELETE", "/sessions/netbird", Some(json!({"negotiationIds": [negotiation_id]}))).await?;
    Ok(())
}

#[tauri::command]
async fn get_provider_status() -> Result<Value, String> {
    let mut profile = peer::local_profile();
    let online = profile.get("online").and_then(Value::as_bool).unwrap_or(false);
    if online {
        let claims = current_identity_claims()?;
        let sub = claims.get("sub").and_then(Value::as_str).ok_or("Cognito account ID is missing.")?;
        let node_id = provider_node_id(sub);
        let hardware = serde_json::to_value(get_hardware().await?).map_err(|e| e.to_string())?;
        // A route/mode switch must not drop provider presence. Use the setup-key
        // flow from the heartbeat to recover a temporarily disconnected daemon.
        let netbird = match get_netbird_status().await {
            Ok(status) if status.get("connected").and_then(Value::as_bool) == Some(true)
                && status.get("peerIp").and_then(Value::as_str).is_some() => status,
            _ => match ensure_netbird_connected("provider").await {
                Ok(status) => status,
                Err(error) => {
                    let _ = computepool_api("DELETE", "/providers/me", Some(json!({"nodeId": node_id}))).await;
                    if let Some(object) = profile.as_object_mut() { object.insert("online".into(), json!(false)); }
                    let _ = peer::set_online(false, "", profile.clone()).await;
                    return Ok(json!({"online": false, "activeSessions": peer::local_sessions().len(), "limits": profile.get("limits"), "connectionError": format!("NetBird disconnected. ComputePool tried to reconnect but could not: {error}"), "capturedAt": peer::now_iso()}));
                }
            }
        };
        let Some(ip) = netbird.get("peerIp").and_then(Value::as_str).filter(|_| netbird.get("connected").and_then(Value::as_bool) == Some(true)) else {
            let _ = computepool_api("DELETE", "/providers/me", Some(json!({"nodeId": node_id}))).await;
            if let Some(object) = profile.as_object_mut() { object.insert("online".into(), json!(false)); }
            let _ = peer::set_online(false, "", profile.clone()).await;
            return Ok(json!({"online": false, "activeSessions": peer::local_sessions().len(), "limits": profile.get("limits"), "connectionError": "NetBird disconnected or has no peer IP. ComputePool will try again automatically while this app remains open.", "capturedAt": peer::now_iso()}));
        };
        if let Some(object) = profile.as_object_mut() { object.insert("netbirdIp".into(), json!(ip)); }
        if let Err(error) = peer::set_online(true, ip, profile.clone()).await {
            let _ = computepool_api("DELETE", "/providers/me", Some(json!({"nodeId": node_id}))).await;
            if let Some(object) = profile.as_object_mut() { object.insert("online".into(), json!(false)); }
            let _ = peer::set_online(false, "", profile.clone()).await;
            return Ok(json!({"online": false, "activeSessions": peer::local_sessions().len(), "limits": profile.get("limits"), "connectionError": error, "capturedAt": peer::now_iso()}));
        }
        let value = match computepool_api("PUT", "/providers/me", Some(json!({
            "nodeId": node_id, "displayName": profile.get("displayName").cloned().unwrap_or_else(|| claims.get("name").cloned().unwrap_or(json!("ComputePool provider"))),
            "netbirdIp": ip, "netbirdPeerId": profile.get("netbirdPeerId").cloned().unwrap_or(Value::Null), "online": true,
            "limits": profile.get("limits").cloned().unwrap_or(json!({})), "gpuNames": profile.get("gpuNames").cloned().unwrap_or(json!([])),
            "cpuModel": hardware.pointer("/cpu/model").cloned().unwrap_or(Value::Null)
        }))).await {
            Ok(value) => value,
            Err(error) => return Ok(json!({
                "online": true, "activeSessions": peer::local_sessions().len(), "limits": profile.get("limits"), "capturedAt": peer::now_iso(),
                "connectionError": format!("This laptop is online locally, but AWS presence could not be refreshed: {error}. ComputePool will retry while the app remains open.")
            })),
        };
        if let Ok(negotiations) = list_negotiations().await {
            let accepted_ids = negotiations.iter()
                .filter(|item| item.get("state").and_then(Value::as_str) == Some("accepted"))
                .filter_map(|item| item.get("id").and_then(Value::as_str).map(ToOwned::to_owned))
                .collect::<std::collections::HashSet<_>>();
            if let Err(error) = peer::reconcile_worker_sessions(&accepted_ids) { eprintln!("Provider worker reconciliation failed: {error}"); }
        }
        let active = peer::local_sessions().len();
        return Ok(json!({ "online": true, "activeSessions": active, "limits": profile.get("limits"), "capturedAt": value.get("capturedAt").cloned().unwrap_or(json!(peer::now_iso())) }));
    }
    let active = peer::local_sessions().len();
    Ok(json!({ "online": false, "activeSessions": active, "limits": profile.get("limits"), "capturedAt": peer::now_iso() }))
}

async fn mark_provider_offline_on_exit() {
    let mut profile = peer::local_profile();
    if profile.get("online").and_then(Value::as_bool) != Some(true) { return; }
    if let Ok(claims) = current_identity_claims() {
        if let Some(sub) = claims.get("sub").and_then(Value::as_str) {
            let payload = json!({"nodeId": provider_node_id(sub)});
            let _ = tokio::time::timeout(Duration::from_secs(4), computepool_api("DELETE", "/providers/me", Some(payload))).await;
        }
    }
    if let Some(object) = profile.as_object_mut() { object.insert("online".into(), json!(false)); }
    let _ = peer::set_online(false, "", profile).await;
}

#[tauri::command]
async fn set_provider_limits(limits: Value) -> Result<(), String> {
    let hardware = serde_json::to_value(get_hardware().await?).map_err(|e| e.to_string())?;
    let cpu = limits.get("cpuCores").and_then(Value::as_u64).unwrap_or(0);
    let memory = limits.get("memoryBytes").and_then(Value::as_u64).unwrap_or(0);
    let max_cpu = hardware.pointer("/cpu/logicalCores").and_then(Value::as_u64).unwrap_or(0);
    let max_memory = hardware.pointer("/memory/availableBytes").and_then(Value::as_u64).unwrap_or(0);
    if cpu == 0 || cpu > max_cpu { return Err(format!("CPU limit must be between 1 and {max_cpu} cores.")); }
    if memory == 0 || memory > max_memory { return Err(format!("Memory limit must be within the currently available {} GiB.", max_memory / 1024_u64.pow(3))); }
    let selected_gpus = limits.get("gpuIds").and_then(Value::as_array).cloned().unwrap_or_default();
    let schedulable_gpus = hardware.get("gpus").and_then(Value::as_array).into_iter().flatten().filter(|gpu| gpu.get("computeSupported").and_then(Value::as_bool) == Some(true)).filter_map(|gpu| gpu.get("id").and_then(Value::as_str)).collect::<std::collections::HashSet<_>>();
    if selected_gpus.iter().any(|id| id.as_str().is_none_or(|id| !schedulable_gpus.contains(id))) { return Err("This build detects GPU display adapters but does not configure K3s GPU scheduling. Save CPU and memory limits without selecting GPUs.".into()); }
    peer::set_local_limits(limits)?;
    Ok(())
}

#[tauri::command]
async fn set_provider_online(online: bool) -> Result<Value, String> {
    let mut profile = peer::local_profile();
    if online {
        let claims = current_identity_claims()?;
        // Enroll/connect on demand when the provider chooses to go online.
        let netbird = ensure_netbird_connected("provider").await?;
        ensure_peer_firewall_access()?;
        let ip = netbird.get("peerIp").and_then(Value::as_str).unwrap_or("");
        let sub = claims.get("sub").and_then(Value::as_str).ok_or("Cognito account ID is missing.")?;
        let node_id = provider_node_id(sub);
        let docker = docker_output(&["info", "--format", "{{.ServerVersion}}"]).ok_or("Docker Desktop is not installed on this provider laptop.")?;
        if !docker.status.success() { return Err("Docker Desktop is installed, but its engine is stopped. Start Docker Desktop before sharing this laptop.".into()); }
        let image = docker_output(&["image", "inspect", K3S_IMAGE, "--format", "{{.Id}}"]).ok_or("Could not check the K3s image in Docker Desktop.")?;
        if !image.status.success() {
            let pull = docker_output(&["pull", K3S_IMAGE]).ok_or("Could not download the K3s worker image.")?;
            if !pull.status.success() { return Err(format!("Could not prepare the K3s worker image: {}", output_text(&pull))); }
        }
        let hardware = serde_json::to_value(get_hardware().await?).map_err(|e| e.to_string())?;
        let mut limits = profile.get("limits").cloned().unwrap_or(json!({"cpuCores": 0, "memoryBytes": 0, "gpuIds": []}));
        let schedulable_gpu_ids = hardware.get("gpus").and_then(Value::as_array).into_iter().flatten()
            .filter(|gpu| gpu.get("computeSupported").and_then(Value::as_bool) == Some(true))
            .filter_map(|gpu| gpu.get("id").and_then(Value::as_str)).collect::<std::collections::HashSet<_>>();
        let selected_gpu_ids = limits.get("gpuIds").and_then(Value::as_array).into_iter().flatten()
            .filter_map(Value::as_str).filter(|id| schedulable_gpu_ids.contains(id)).map(ToOwned::to_owned).collect::<Vec<_>>();
        if let Some(object) = limits.as_object_mut() { object.insert("gpuIds".into(), json!(selected_gpu_ids)); }
        let gpu_names = hardware.get("gpus").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter(|gpu| limits.get("gpuIds").and_then(Value::as_array).is_some_and(|ids| ids.iter().any(|id| id.as_str() == gpu.get("id").and_then(Value::as_str)))).filter_map(|gpu| gpu.get("name").cloned()).collect::<Vec<_>>();
        profile = json!({
            "id": node_id, "peerId": node_id, "displayName": claims.get("name").or_else(|| claims.get("given_name")).and_then(Value::as_str).unwrap_or_else(|| claims.get("email").and_then(Value::as_str).unwrap_or("ComputePool provider")),
            "username": claims.get("email").and_then(Value::as_str).unwrap_or(""), "ownerSub": sub,
            "netbirdIp": ip, "online": true, "limits": limits, "availableCores": limits.get("cpuCores").and_then(Value::as_u64).unwrap_or(0),
            "availableMemoryBytes": limits.get("memoryBytes").and_then(Value::as_u64).unwrap_or(0), "gpuNames": gpu_names, "price": null,
            "cpuModel": hardware.pointer("/cpu/model").cloned().unwrap_or(Value::Null), "hardware": hardware, "capturedAt": peer::now_iso()
        });
        peer::set_online(true, ip, profile.clone()).await?;
        if let Err(error) = computepool_api("PUT", "/providers/me", Some(json!({
            "nodeId": node_id, "displayName": profile["displayName"], "netbirdIp": ip, "netbirdPeerId": profile["peerId"],
            "online": true, "limits": limits, "gpuNames": profile["gpuNames"], "cpuModel": profile["cpuModel"]
        }))).await {
            return Ok(json!({
                "online": true, "activeSessions": peer::local_sessions().len(), "capturedAt": peer::now_iso(),
                "connectionError": format!("This laptop is online locally, but AWS presence could not be published: {error}. ComputePool will retry while the app remains open.")
            }));
        }
    } else {
        if !peer::local_sessions().is_empty() { return Err("This provider has an active worker session. End the consumer session before stopping availability.".into()); }
        let claims = current_identity_claims()?;
        let sub = claims.get("sub").and_then(Value::as_str).ok_or("Cognito account ID is missing.")?;
        let node_id = provider_node_id(sub);
        if profile.is_null() { profile = json!({"online": false}); }
        if let Some(obj) = profile.as_object_mut() { obj.insert("online".into(), json!(false)); }
        peer::set_online(false, "", profile).await?;
        let _ = computepool_api("DELETE", "/providers/me", Some(json!({"nodeId": node_id}))).await?;
    }
    get_provider_status().await
}

#[tauri::command]
async fn list_incoming_requests() -> Result<Vec<Value>, String> {
    let claims = current_identity_claims()?;
    let sub = claims.get("sub").and_then(Value::as_str).ok_or("Cognito account ID is missing.")?;
    Ok(list_negotiations().await?.into_iter().filter(|item| item.get("providerSub").and_then(Value::as_str) == Some(sub) && item.get("state").and_then(Value::as_str) == Some("open")).collect())
}

#[tauri::command]
async fn list_provider_sessions() -> Result<Vec<Value>, String> {
    let claims = current_identity_claims()?;
    let sub = claims.get("sub").and_then(Value::as_str).ok_or("Cognito account ID is missing.")?;
    let local = peer::local_sessions();
    Ok(list_negotiations().await?.into_iter()
        .filter(|item| item.get("providerSub").and_then(Value::as_str) == Some(sub) && item.get("state").and_then(Value::as_str) == Some("accepted"))
        .map(|item| {
            let id = item.get("id").and_then(Value::as_str).unwrap_or_default();
            let live = local.iter().find(|session| session.get("consumerRequestId").and_then(Value::as_str) == Some(id));
            let limits = item.get("requestedLimits").or_else(|| item.pointer("/proposal/limits"));
            let mut result = live.cloned().unwrap_or_else(|| json!({
                "id": id,
                "consumer": item.get("consumerName").or_else(|| item.get("consumer")).cloned().unwrap_or(json!("ComputePool consumer")),
                "state": "accepted",
                "startedAt": item.get("updatedAt").or_else(|| item.get("createdAt")).cloned().unwrap_or(json!(peer::now_iso())),
                "telemetryAvailable": false
            }));
            result["id"] = json!(id);
            result["consumer"] = item.get("consumerName").or_else(|| item.get("consumer")).cloned().unwrap_or(json!("ComputePool consumer"));
            result["requestedCpuCores"] = limits.and_then(|v| v.get("cpuCores")).cloned().unwrap_or(Value::Null);
            result["requestedMemoryBytes"] = limits.and_then(|v| v.get("memoryBytes")).cloned().unwrap_or(Value::Null);
            result["requestedGpuIds"] = limits.and_then(|v| v.get("gpuIds")).cloned().unwrap_or(json!([]));
            result["durationMinutes"] = item.get("durationMinutes").cloned().unwrap_or(Value::Null);
            result["workloadDescription"] = item.get("workloadDescription").cloned().unwrap_or(Value::Null);
            result
        }).collect())
}

#[tauri::command]
async fn list_provider_live_telemetry() -> Result<Vec<Value>, String> {
    let claims = current_identity_claims()?;
    let sub = claims.get("sub").and_then(Value::as_str).ok_or("Cognito account ID is missing.")?;
    Ok(peer::local_sessions().into_iter().filter_map(|mut session| {
        if session.get("ownerSub").and_then(Value::as_str) != Some(sub) { return None; }
        let request_id = session.get("consumerRequestId").and_then(Value::as_str).unwrap_or_default().to_string();
        if request_id.is_empty() { return None; }
        session["clusterSessionId"] = session.get("id").cloned().unwrap_or(Value::Null);
        session["id"] = json!(request_id);
        Some(session)
    }).collect())
}

#[tauri::command(rename_all = "camelCase")]
async fn decide_provider_request(request_id: String, decision: String) -> Result<(), String> {
    if decision != "accept" && decision != "reject" { return Err("Choose accept or reject.".into()); }
    if decision == "accept" {
        let claims = current_identity_claims()?;
        let sub = claims.get("sub").and_then(Value::as_str).ok_or("Cognito account ID is missing.")?;
        let mut profile = peer::local_profile();
        if profile.get("online").and_then(Value::as_bool) != Some(true) { return Err("Turn this laptop online in Provider before accepting a request.".into()); }
        let netbird = ensure_netbird_connected("provider").await?;
        let ip = netbird.get("peerIp").and_then(Value::as_str).ok_or("NetBird did not assign this laptop a peer IP.")?;
        if let Some(object) = profile.as_object_mut() { object.insert("netbirdIp".into(), json!(ip)); }
        peer::set_online(true, ip, profile.clone()).await?;
        let hardware = serde_json::to_value(get_hardware().await?).map_err(|e| e.to_string())?;
        let limits = profile.get("limits").cloned().unwrap_or(json!({}));
        let _ = computepool_api("PUT", "/providers/me", Some(json!({
            "nodeId": provider_node_id(sub), "displayName": profile.get("displayName").cloned().unwrap_or(json!("ComputePool provider")),
            "netbirdIp": ip, "netbirdPeerId": profile.get("peerId").cloned().unwrap_or(Value::Null), "online": true,
            "limits": limits, "gpuNames": profile.get("gpuNames").cloned().unwrap_or(json!([])), "cpuModel": hardware.pointer("/cpu/model").cloned().unwrap_or(Value::Null)
        }))).await?;
    }
    decide_resource_proposal(request_id, decision).await
}

#[tauri::command(rename_all = "camelCase")]
async fn get_provider_messages(consumer_id: String) -> Result<Vec<Value>, String> {
    let items = list_negotiations().await?;
    let item = items.iter().find(|n| n.get("consumer").and_then(Value::as_str) == Some(consumer_id.as_str()) || n.get("consumerSub").and_then(Value::as_str) == Some(consumer_id.as_str())).ok_or("No negotiation exists with this consumer yet.")?;
    let id = item.get("id").and_then(Value::as_str).ok_or("Negotiation ID is missing.")?;
    let value = computepool_api("GET", &format!("/negotiations/{id}/messages"), None).await?;
    value.as_array().cloned().ok_or_else(|| "ComputePool message service returned invalid data.".into())
}

#[tauri::command(rename_all = "camelCase")]
async fn send_provider_message(consumer_id: String, body: String) -> Result<(), String> {
    let items = list_negotiations().await?;
    let item = items.iter().find(|n| n.get("consumer").and_then(Value::as_str) == Some(consumer_id.as_str()) || n.get("consumerSub").and_then(Value::as_str) == Some(consumer_id.as_str())).ok_or("No negotiation exists with this consumer yet.")?;
    let id = item.get("id").and_then(Value::as_str).ok_or("Negotiation ID is missing.")?;
    let _ = computepool_api("POST", &format!("/negotiations/{id}/messages"), Some(json!({"text":body}))).await?;
    Ok(())
}

const SHARED_CLUSTER_ID: &str = "computepool";
const K3S_SERVER_CONTAINER: &str = "cp-k3s-server";
const K3S_IMAGE: &str = "rancher/k3s:v1.31.5-k3s1";
const METRICS_SERVER_MANIFEST: &str = "https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.7.2/components.yaml";
const SESSION_PROGRESS_EVENT: &str = "computepool-session-progress";

fn publish_session_progress(app: &AppHandle, session_id: &str, status: &str, stages: &[Value], error: Option<&str>) {
    let value = json!({"sessionId": session_id, "clusterId": SHARED_CLUSTER_ID, "status": status, "stages": stages, "error": error});
    if let Ok(mut sessions) = SESSION_PROGRESS.get_or_init(|| Mutex::new(HashMap::new())).lock() {
        sessions.insert(session_id.to_string(), value.clone());
        while sessions.len() > 32 {
            if let Some(oldest) = sessions.keys().next().cloned() { sessions.remove(&oldest); } else { break; }
        }
    }
    let _ = app.emit(SESSION_PROGRESS_EVENT, value);
}

fn update_session_stage(app: &AppHandle, session_id: &str, status: &str, stages: &mut [Value], stage_id: &str, stage_status: &str, detail: impl Into<String>, error: Option<&str>) {
    if let Some(stage) = stages.iter_mut().find(|stage| stage.get("id").and_then(Value::as_str) == Some(stage_id)) {
        stage["status"] = json!(stage_status);
        stage["detail"] = json!(detail.into());
    }
    publish_session_progress(app, session_id, status, stages, error);
}

fn cluster_node_readiness() -> Result<(usize, usize, Vec<String>), String> {
    let output = server_kubectl(&["get", "nodes", "-o", "json"]).ok_or("Docker could not query the K3s API from the consumer laptop.")?;
    if !output.status.success() { return Err(format!("K3s node query failed: {}", output_text(&output))); }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|error| format!("K3s returned invalid node status: {error}"))?;
    let nodes = value.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
    let summary = nodes.iter().map(|node| {
        let name = node.pointer("/metadata/name").and_then(Value::as_str).unwrap_or("unnamed");
        let ready = node.pointer("/status/conditions").and_then(Value::as_array).into_iter().flatten().find(|condition| condition.get("type").and_then(Value::as_str) == Some("Ready")).and_then(|condition| condition.get("status")).and_then(Value::as_str).unwrap_or("Unknown");
        format!("{name}={ready}")
    }).collect::<Vec<_>>();
    let ready = summary.iter().filter(|entry| entry.ends_with("=True")).count();
    Ok((ready, nodes.len(), summary))
}

fn install_metrics_server() -> Result<(), String> {
    let apply = server_kubectl(&["apply", "-f", METRICS_SERVER_MANIFEST])
        .ok_or("Docker could not run kubectl to install Kubernetes Metrics Server.")?;
    if !apply.status.success() {
        return Err(format!("Could not install Kubernetes Metrics Server: {}", output_text(&apply)));
    }

    // Laptop worker kubelets normally use certificates that are not signed by
    // the cluster CA. Metrics Server needs this flag to scrape those kubelets.
    let deployment = server_kubectl(&["get", "deployment", "metrics-server", "-n", "kube-system", "-o", "json"])
        .ok_or("Docker could not inspect the Metrics Server deployment.")?;
    if !deployment.status.success() {
        return Err(format!("Metrics Server manifest applied, but its deployment could not be read: {}", output_text(&deployment)));
    }
    let value: Value = serde_json::from_slice(&deployment.stdout)
        .map_err(|error| format!("Metrics Server deployment returned invalid JSON: {error}"))?;
    let args = value.pointer("/spec/template/spec/containers/0/args").and_then(Value::as_array).cloned().unwrap_or_default();
    if !args.iter().any(|arg| arg.as_str() == Some("--kubelet-insecure-tls")) {
        let patch = r#"[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]"#;
        let output = server_kubectl(&["patch", "deployment", "metrics-server", "-n", "kube-system", "--type=json", "-p", patch])
            .ok_or("Docker could not configure Metrics Server to scrape K3s worker kubelets.")?;
        if !output.status.success() {
            return Err(format!("Could not configure Metrics Server kubelet access: {}", output_text(&output)));
        }
    }

    let rollout = server_kubectl(&["rollout", "status", "deployment/metrics-server", "-n", "kube-system", "--timeout=120s"])
        .ok_or("Docker could not wait for Metrics Server to start.")?;
    if !rollout.status.success() {
        let logs = server_kubectl(&["logs", "-n", "kube-system", "deployment/metrics-server", "--tail=30"])
            .map(|output| output_text(&output)).unwrap_or_default();
        return Err(format!("Metrics Server did not become ready: {}{}", output_text(&rollout), if logs.is_empty() { String::new() } else { format!(". Recent logs: {logs}") }));
    }
    Ok(())
}

fn node_metrics_ready(expected: usize) -> Result<(usize, Vec<String>), String> {
    let output = server_kubectl(&["get", "--raw", "/apis/metrics.k8s.io/v1beta1/nodes"])
        .ok_or("Could not query Kubernetes Metrics Server (metrics.k8s.io).")?;
    if !output.status.success() {
        return Err(format!("Metrics API is not ready: {}", output_text(&output)));
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Metrics Server returned invalid node data: {error}"))?;
    let names = value.get("items").and_then(Value::as_array).into_iter().flatten()
        .filter_map(|item| item.pointer("/metadata/name").and_then(Value::as_str).map(ToOwned::to_owned))
        .collect::<Vec<_>>();
    if names.len() < expected {
        return Err(format!("Metrics Server has samples for {}/{} nodes.", names.len(), expected));
    }
    Ok((names.len(), names))
}

fn server_kubectl(args: &[&str]) -> Option<Output> {
    let mut all = vec!["exec", K3S_SERVER_CONTAINER, "kubectl"];
    all.extend_from_slice(args);
    docker_output(&all)
}

fn cluster_output(cluster_id: &str, args: &[&str]) -> Option<Output> {
    if cluster_id == SHARED_CLUSTER_ID { server_kubectl(args) }
    else {
        let mut all = vec!["--context", cluster_id];
        all.extend_from_slice(args);
        command_output("kubectl.exe", &all).or_else(|| command_output("kubectl", &all))
    }
}

fn bootstrap_shared_cluster(ip: &str, workspace: &str) -> Result<String, String> {
    let daemon = docker_output(&["info", "--format", "{{.ServerVersion}}"])
        .ok_or("Docker Desktop is not installed on the consumer laptop.")?;
    if !daemon.status.success() { return Err("Docker Desktop is installed but its engine is stopped. Start Docker Desktop, then start the compute session again.".into()); }
    let existing = docker_output(&["inspect", K3S_SERVER_CONTAINER]);
    if existing.as_ref().is_some_and(|out| out.status.success()) { return Err("A ComputePool K3s server already exists in Docker. End or recover that session before starting another.".into()); }
    if docker_output(&["volume", "inspect", "cp-k3s-state"]).is_some_and(|out| out.status.success()) {
        // The control-plane container check above proved no ComputePool cluster
        // is running. This app-reserved volume contains only K3s state; consumer
        // project files live in the separate /workspace bind mount. Reclaim the
        // orphaned volume automatically so a failed/crashed prior bootstrap can
        // be retried without asking users to operate Docker Desktop manually.
        let removed = docker_output(&["volume", "rm", "cp-k3s-state"])
            .ok_or("Docker could not inspect or remove the abandoned ComputePool K3s state volume.")?;
        if !removed.status.success() {
            return Err(format!(
                "An old ComputePool K3s state volume is still in use and was left untouched: {}. Stop the container using cp-k3s-state, then retry.",
                output_text(&removed)
            ));
        }
    }
    let volume = docker_output(&["volume", "create", "--label", "com.computepool.managed=true", "--label", "com.computepool.role=cluster-state", "cp-k3s-state"]).ok_or("Docker could not create the K3s data volume.")?;
    if !volume.status.success() { return Err(format!("Could not create K3s data volume: {}", output_text(&volume))); }
    let workspace_mount = format!("{workspace}:/workspace");
    let api_port = format!("{ip}:6443:6443/tcp");
    let vxlan_port = format!("{ip}:8472:8472/udp");
    let kubelet_port = format!("{ip}:10250:10250/tcp");
    let run_args = ["run", "-d", "--name", K3S_SERVER_CONTAINER, "--label", "com.computepool.managed=true", "--label", "com.computepool.role=control-plane", "--privileged", "--publish", &api_port, "--publish", &vxlan_port, "--publish", &kubelet_port, "--volume", "cp-k3s-state:/var/lib/rancher/k3s", "--volume", &workspace_mount, K3S_IMAGE, "server", "--tls-san", ip, "--node-ip", ip, "--advertise-address", ip, "--node-external-ip", ip];
    let run = docker_output(&run_args).ok_or("Docker could not start the K3s server container.")?;
    if !run.status.success() { let _ = docker_output(&["volume", "rm", "cp-k3s-state"]); return Err(format!("Could not start the shared K3s server: {}", output_text(&run))); }
    let mut last_error = "K3s control-plane node has not registered yet.".to_string();
    for _ in 0..120 {
        match cluster_node_readiness() {
            Ok((ready, total, _)) if total >= 1 && ready >= 1 => {
                let token = docker_output(&["exec", K3S_SERVER_CONTAINER, "cat", "/var/lib/rancher/k3s/server/node-token"]);
                match token {
                    Some(token) if token.status.success() => return Ok(String::from_utf8_lossy(&token.stdout).trim().to_string()),
                    Some(output) => last_error = output_text(&output),
                    None => last_error = "Docker could not read the K3s node token.".into(),
                }
                break;
            }
            Ok((_, _, nodes)) if !nodes.is_empty() => last_error = format!("K3s control-plane node is not Ready: {}", nodes.join(", ")),
            Err(error) => last_error = error,
            _ => {}
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    let logs = docker_output(&["logs", "--tail", "80", K3S_SERVER_CONTAINER]).map(|output| output_text(&output)).unwrap_or_default();
    let _ = docker_output(&["rm", "-f", K3S_SERVER_CONTAINER]);
    let _ = docker_output(&["volume", "rm", "cp-k3s-state"]);
    Err(format!("K3s control plane did not become Ready: {last_error}. Container log tail: {}", if logs.is_empty() { "(no logs returned)" } else { &logs }))
}

async fn establish_compute_session(app: &AppHandle, session_id: &str, negotiation_ids: Vec<String>, workspace: String, stages: &mut Vec<Value>) -> Result<Value, String> {
    update_session_stage(app, session_id, "connecting", stages, "validation", "running", "Checking accepted requests and provider capacity", None);
    if !Path::new(&workspace).is_dir() { return Err("Choose an existing consumer project folder before starting the session.".into()); }
    if negotiation_ids.is_empty() { return Err("At least one provider must accept before a session can start.".into()); }
    let id_token = current_id_token().await?;
    let negotiations = list_negotiations().await?;
    let mut accepted = Vec::new();
    let mut provider_ids = Vec::new();
    let mut duplicate_provider_offers = 0usize;
    for id in &negotiation_ids {
        let item = negotiations.iter().find(|n| n.get("id").and_then(Value::as_str) == Some(id.as_str())).ok_or_else(|| format!("Provider request {id} was not found on this laptop."))?;
        if item.get("state").and_then(Value::as_str) != Some("accepted") { return Err("Every selected provider must accept before the cluster starts.".into()); }
        let provider_ip = item.pointer("/provider/netbirdIp").and_then(Value::as_str).ok_or("An accepted provider has no NetBird address.")?;
        if provider_ip.parse::<std::net::IpAddr>().is_err() { return Err("An accepted provider has an invalid NetBird address. Refresh its online status and retry.".into()); }
        let provider_id = item.get("providerId").and_then(Value::as_str).ok_or("An accepted request has no provider ID.")?;
        // A provider laptop is one physical K3s worker. Old app versions could
        // create several accepted offers for the same laptop; join it once.
        if provider_ids.iter().any(|existing| existing == provider_id) { duplicate_provider_offers += 1; continue; }
        provider_ids.push(provider_id.to_string());
        let provider = item.get("provider").cloned().ok_or("Provider connection details are missing.")?;
        if provider.get("netbirdIp").and_then(Value::as_str) != Some(provider_ip) { return Err("Provider NetBird address changed. Refresh negotiation and retry.".into()); }
        accepted.push(item.clone());
    }
    let validation_detail = if duplicate_provider_offers == 0 {
        format!("{} accepted provider(s); consumer folder verified", accepted.len())
    } else {
        format!("{} provider laptop(s) selected; skipped {duplicate_provider_offers} duplicate accepted offer(s) for laptops already selected; consumer folder verified", accepted.len())
    };
    update_session_stage(app, session_id, "connecting", stages, "validation", "completed", validation_detail, None);

    update_session_stage(app, session_id, "connecting", stages, "netbird", "running", "Verifying the consumer and accepted provider peer addresses", None);
    let netbird = ensure_netbird_connected("consumer").await?;
    let server_ip = netbird.get("peerIp").and_then(Value::as_str).ok_or("NetBird has not reported the consumer laptop's IP.")?.to_string();
    if server_ip.parse::<std::net::IpAddr>().is_err() { return Err(format!("NetBird returned an invalid consumer address: {server_ip}")); }
    update_session_stage(app, session_id, "connecting", stages, "netbird", "completed", format!("Consumer peer {server_ip}; provider peers verified from accepted requests"), None);

    update_session_stage(app, session_id, "connecting", stages, "firewall", "running", "Allowing only the required ports from the NetBird address range", None);
    ensure_peer_firewall_access()?;
    update_session_stage(app, session_id, "connecting", stages, "firewall", "completed", "TCP 47631/6443/10250 and UDP 8472 allowed from 100.64.0.0/10", None);

    let accepted_ids = accepted.iter().filter_map(|item| item.get("id").and_then(Value::as_str).map(ToOwned::to_owned)).collect::<Vec<_>>();
    update_session_stage(app, session_id, "connecting", stages, "access", "running", "Creating access for only the consumer and these accepted providers", None);
    computepool_api("POST", "/sessions/netbird", Some(json!({"negotiationIds": accepted_ids, "consumerPeerIp": server_ip}))).await?;
    update_session_stage(app, session_id, "connecting", stages, "access", "completed", "Temporary NetBird session policy granted", None);

    update_session_stage(app, session_id, "connecting", stages, "server", "running", "Starting the consumer K3s control plane in Docker Desktop", None);
    let workspace_path = workspace.clone();
    let server_address = server_ip.clone();
    let token = match tokio::task::spawn_blocking(move || bootstrap_shared_cluster(&server_address, &workspace_path)).await {
        Ok(Ok(token)) => token,
        Ok(Err(error)) => { let _ = computepool_api("DELETE", "/sessions/netbird", Some(json!({"negotiationIds": accepted_ids, "preserveAccepted": true}))).await; return Err(error); }
        Err(_) => { let _ = computepool_api("DELETE", "/sessions/netbird", Some(json!({"negotiationIds": accepted_ids, "preserveAccepted": true}))).await; return Err("K3s bootstrap task failed. The temporary NetBird permission was revoked.".into()); }
    };
    update_session_stage(app, session_id, "connecting", stages, "server", "completed", "Docker container started and K3s control-plane node is Ready", None);

    let all_providers = accepted.iter().filter_map(|item| item.get("provider").cloned()).collect::<Vec<_>>();
    update_session_stage(app, session_id, "connecting", stages, "workers", "running", format!("Joining 0/{} provider worker nodes", all_providers.len()), None);
    let mut connected = Vec::new();
    for (index, item) in accepted.iter().enumerate() {
        let request_id = item.get("id").and_then(Value::as_str).unwrap_or_default();
        let provider = item.get("provider").cloned().ok_or("Provider connection details are missing.")?;
        let provider_ip = provider.get("netbirdIp").and_then(Value::as_str).ok_or("An accepted provider has no NetBird address.")?;
        update_session_stage(app, session_id, "connecting", stages, "workers", "running", format!("Contacting provider {} ({}/{}) over NetBird", provider.get("displayName").and_then(Value::as_str).unwrap_or(provider_ip), index + 1, accepted.len()), None);
        let request = json!({"sessionId": session_id, "consumerRequestId": request_id, "serverIp": server_ip, "serverToken": token, "providerIp": provider_ip});
        let mut result = Err("Peer access policy is still propagating.".to_string());
        for attempt in 1..=8 {
            match peer::remote_request_action(&provider, &id_token, request_id, "cluster/join", request.clone()).await {
                Ok(value) => { result = Ok(value); break; }
                Err(error) => {
                    let permanent = ["HTTP 400", "HTTP 401", "HTTP 403", "HTTP 404"].iter().any(|status| error.contains(status));
                    result = Err(error);
                    if permanent || attempt == 8 { break; }
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            }
        }
        match result {
            Ok(value) => connected.push(json!({"requestId": request_id, "provider": provider, "node": value.get("nodeName").cloned().unwrap_or(Value::Null)})),
            Err(error) => {
                for joined_provider in &all_providers { let _ = peer::remote_service_action(joined_provider, &id_token, "cluster/leave", json!({"sessionId": session_id})).await; }
                let _ = docker_output(&["rm", "-f", K3S_SERVER_CONTAINER]);
                let _ = docker_output(&["volume", "rm", "cp-k3s-state"]);
                let _ = computepool_api("DELETE", "/sessions/netbird", Some(json!({"negotiationIds": accepted_ids, "preserveAccepted": true}))).await;
                return Err(format!("Could not connect provider {} at NetBird IP {provider_ip}: {error}. Check that TCP 47631 reaches the provider app, TCP 6443 reaches the consumer K3s server, and UDP 8472 is allowed between worker nodes.", provider.get("displayName").and_then(Value::as_str).unwrap_or(provider_ip)));
            }
        }
        update_session_stage(app, session_id, "connecting", stages, "workers", "running", format!("Joined {}/{} provider worker nodes", connected.len(), accepted.len()), None);
    }
    update_session_stage(app, session_id, "connecting", stages, "workers", "completed", format!("{} provider worker(s) started", connected.len()), None);

    let expected = connected.len() + 1;
    update_session_stage(app, session_id, "connecting", stages, "ready", "running", format!("Waiting for {expected} Ready Kubernetes nodes"), None);
    let mut last_nodes = String::from("No node has registered yet.");
    let mut ready = false;
    for attempt in 0..180 {
        let check = tokio::task::spawn_blocking(cluster_node_readiness).await.map_err(|_| "Kubernetes node readiness check failed to run.")?;
        match check {
            Ok((ready_count, total, summary)) => {
                last_nodes = if summary.is_empty() { "No node has registered yet.".into() } else { summary.join(", ") };
                if total == expected && ready_count == expected { ready = true; break; }
                if attempt % 5 == 0 { update_session_stage(app, session_id, "connecting", stages, "ready", "running", format!("{ready_count}/{expected} Ready nodes · {last_nodes}"), None); }
            }
            Err(error) => last_nodes = error,
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    if !ready {
        for provider in &all_providers { let _ = peer::remote_service_action(provider, &id_token, "cluster/leave", json!({"sessionId": session_id})).await; }
        let _ = docker_output(&["rm", "-f", K3S_SERVER_CONTAINER]);
        let _ = docker_output(&["volume", "rm", "cp-k3s-state"]);
        let _ = computepool_api("DELETE", "/sessions/netbird", Some(json!({"negotiationIds": accepted_ids, "preserveAccepted": true}))).await;
        return Err(format!("K3s did not reach the expected Ready state within 180 seconds. Expected {expected} nodes; observed: {last_nodes}. Verify Docker Desktop, the NetBird peer link and firewall access, then retry."));
    }
    update_session_stage(app, session_id, "connecting", stages, "ready", "completed", format!("All {expected} Kubernetes nodes are Ready"), None);
    Ok(json!({"sessionId": session_id, "clusterId": SHARED_CLUSTER_ID, "serverIp": server_ip, "workspace": workspace, "providers": connected, "negotiationIds": accepted_ids, "startedAt": peer::now_iso()}))
}

async fn install_metrics_in_background(app: AppHandle, session_id: String, expected: usize, mut stages: Vec<Value>) {
    update_session_stage(&app, &session_id, "ready", &mut stages, "metrics", "running", format!("Cluster is ready; installing Metrics Server for {expected} nodes"), None);
    let install = tokio::task::spawn_blocking(install_metrics_server).await;
    let install_error = match install {
        Ok(Ok(())) => None,
        Ok(Err(error)) => Some(error),
        Err(_) => Some("Metrics Server installation task failed to run.".to_string()),
    };
    if let Some(error) = install_error {
        update_session_stage(&app, &session_id, "ready", &mut stages, "metrics", "failed", error, None);
        return;
    }

    let mut last_metrics = String::from("Metrics Server deployment is ready; waiting for the first CPU/RAM samples.");
    for attempt in 0..60 {
        match tokio::task::spawn_blocking(move || node_metrics_ready(expected)).await {
            Ok(Ok((count, names))) => {
                update_session_stage(&app, &session_id, "ready", &mut stages, "metrics", "completed", format!("Live CPU/RAM samples received from {count}/{expected} nodes: {}", names.join(", ")), None);
                return;
            }
            Ok(Err(error)) => last_metrics = error,
            Err(_) => last_metrics = "Metrics Server sample check could not run in the K3s container.".into(),
        }
        if attempt % 5 == 0 {
            update_session_stage(&app, &session_id, "ready", &mut stages, "metrics", "running", last_metrics.clone(), None);
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    update_session_stage(&app, &session_id, "ready", &mut stages, "metrics", "failed", format!("CPU/RAM samples did not arrive within 120 seconds: {last_metrics}. The cluster remains available; retry telemetry setup or inspect Metrics Server logs."), None);
}

#[tauri::command(rename_all = "camelCase")]
async fn start_compute_session(app: AppHandle, negotiation_ids: Vec<String>, consumer_workspace_path: String, output_policy: String) -> Result<Value, String> {
    if output_policy != "consumer_local_only" { return Err("ComputePool only supports consumer-local output storage.".into()); }
    if ACTIVE_COMPUTE_SESSION.get_or_init(|| Mutex::new(None)).lock().map_err(|_| "Session state is unavailable.")?.is_some() { return Err("A ComputePool session is already active on this laptop.".into()); }
    let uuid = uuid::Uuid::new_v4().simple().to_string();
    let session_id = format!("cp-{}", &uuid[..12]);
    let mut stages = vec![
        json!({"id":"validation","label":"Validate accepted providers","status":"pending"}),
        json!({"id":"netbird","label":"Verify NetBird peer connectivity","status":"pending"}),
        json!({"id":"firewall","label":"Check private peer networking","status":"pending"}),
        json!({"id":"access","label":"Grant session-only peer access","status":"pending"}),
        json!({"id":"server","label":"Start consumer K3s control plane","status":"pending"}),
        json!({"id":"workers","label":"Join provider worker nodes","status":"pending"}),
        json!({"id":"ready","label":"Wait for Kubernetes node readiness","status":"pending"}),
        json!({"id":"metrics","label":"Install Metrics Server and verify CPU/RAM telemetry","status":"pending"}),
    ];
    let initial = json!({"sessionId":session_id,"clusterId":SHARED_CLUSTER_ID,"negotiationIds":negotiation_ids,"status":"connecting","stages":stages,"error":null});
    {
        let mut sessions = SESSION_PROGRESS.get_or_init(|| Mutex::new(HashMap::new())).lock().map_err(|_| "Session progress state is unavailable.")?;
        if sessions.values().any(|value| value.get("status").and_then(Value::as_str) == Some("connecting")) { return Err("A ComputePool session is already starting on this laptop.".into()); }
        sessions.insert(session_id.clone(), initial.clone());
    }
    let _ = app.emit(SESSION_PROGRESS_EVENT, initial);
    update_session_stage(&app, &session_id, "connecting", &mut stages, "validation", "running", "Checking accepted requests and provider capacity", None);
    let result = establish_compute_session(&app, &session_id, negotiation_ids, consumer_workspace_path, &mut stages).await;
    match result {
        Ok(state) => {
            let expected = state.get("providers").and_then(Value::as_array).map_or(1, |providers| providers.len() + 1);
            *ACTIVE_COMPUTE_SESSION.get_or_init(|| Mutex::new(None)).lock().map_err(|_| "Session state is unavailable.")? = Some(state);
            publish_session_progress(&app, &session_id, "ready", &stages, None);
            let metrics_app = app.clone();
            let metrics_session_id = session_id.clone();
            let metrics_stages = stages.clone();
            tauri::async_runtime::spawn(async move {
                install_metrics_in_background(metrics_app, metrics_session_id, expected, metrics_stages).await;
            });
            Ok(json!({"sessionId": session_id, "clusterId": SHARED_CLUSTER_ID}))
        }
        Err(error) => {
            if let Some(stage) = stages.iter_mut().find(|stage| stage.get("status").and_then(Value::as_str) == Some("running")) {
                stage["status"] = json!("failed");
                stage["detail"] = json!(error);
            }
            publish_session_progress(&app, &session_id, "failed", &stages, Some(&error));
            Err(error)
        }
    }
}

fn parse_quantity_bytes(value: &str) -> Option<u64> {
    for (suffix, power) in [("Ki", 10_u32), ("Mi", 20), ("Gi", 30), ("Ti", 40), ("K", 10), ("M", 20), ("G", 30), ("T", 40)] {
        if let Some(number) = value.strip_suffix(suffix) { return number.parse::<f64>().ok().map(|n| (n * 2_f64.powi(power as i32)) as u64); }
    }
    value.parse::<u64>().ok()
}

fn node_metric_map(cluster_id: &str) -> Result<HashMap<String, Value>, String> {
    // `kubectl top nodes -o json` is not a supported kubectl output format on
    // many versions. Read the Metrics API resource directly instead.
    let output = cluster_output(cluster_id, &["get", "--raw", "/apis/metrics.k8s.io/v1beta1/nodes"])
        .ok_or("Could not query Kubernetes Metrics Server (metrics.k8s.io). Check that the cluster is reachable and Metrics Server is installed.")?;
    if !output.status.success() {
        return Err(format!("Kubernetes node telemetry is unavailable: {}. Ensure Metrics Server is running in kube-system.", output_text(&output)));
    }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|error| format!("Metrics Server returned invalid node data: {error}"))?;
    Ok(value.get("items").and_then(Value::as_array).into_iter().flatten().filter_map(|item| {
        Some((item.pointer("/metadata/name")?.as_str()?.to_string(), item.get("usage")?.clone()))
    }).collect())
}

fn parse_cpu_cores(value: &str) -> Option<f32> {
    let value = value.trim();
    if let Some(number) = value.strip_suffix('n') { return number.parse::<f32>().ok().map(|v| v / 1_000_000_000.0); }
    if let Some(number) = value.strip_suffix('u') { return number.parse::<f32>().ok().map(|v| v / 1_000_000.0); }
    if let Some(number) = value.strip_suffix('m') { return number.parse::<f32>().ok().map(|v| v / 1_000.0); }
    value.parse::<f32>().ok()
}

#[tauri::command(rename_all = "camelCase")]
async fn get_cluster_snapshot(cluster_id: Option<String>) -> Result<Value, String> {
    let cluster_id = cluster_id.unwrap_or_else(|| SHARED_CLUSTER_ID.to_string());
    let output = cluster_output(&cluster_id, &["get", "nodes", "-o", "json"]).ok_or("Docker or kubectl is not installed.")?;
    if !output.status.success() { return Err(format!("K3s cluster is unavailable: {}", output_text(&output))); }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|e| format!("K3s returned invalid node data: {e}"))?;
    let (metrics, metrics_error) = match node_metric_map(&cluster_id) { Ok(metrics) => (metrics, None), Err(error) => (HashMap::new(), Some(error)) };
    let nodes = value.get("items").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter_map(|node| {
        let metadata = node.get("metadata")?;
        let name = metadata.get("name")?.as_str()?.to_string();
        let capacity = node.pointer("/status/capacity").cloned().unwrap_or(Value::Null);
        let allocatable = node.pointer("/status/allocatable").cloned().unwrap_or(Value::Null);
        let ready = node.pointer("/status/conditions").and_then(Value::as_array).into_iter().flatten().any(|c| c.get("type").and_then(Value::as_str) == Some("Ready") && c.get("status").and_then(Value::as_str) == Some("True"));
        let labels = metadata.get("labels").cloned().unwrap_or(Value::Null);
        let role = if labels.get("node-role.kubernetes.io/control-plane").is_some() { "control-plane" } else { "worker" };
        let cpu = capacity.get("cpu").and_then(Value::as_str).and_then(|s| s.parse::<f32>().ok());
        let memory = capacity.get("memory").and_then(Value::as_str).and_then(parse_quantity_bytes);
        let gpu_count = allocatable.get("nvidia.com/gpu").and_then(Value::as_str).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
        let metric = metrics.get(&name);
        let cpu_used = metric.and_then(|m| m.get("cpu")).and_then(Value::as_str).and_then(parse_cpu_cores);
        let memory_used = metric.and_then(|m| m.get("memory")).and_then(Value::as_str).and_then(parse_quantity_bytes);
        let cpu_percent = cpu.zip(cpu_used).map(|(total, used)| (used / total.max(1.0) * 100.0).clamp(0.0, 100.0));
        let memory_percent = memory.zip(memory_used).map(|(total, used)| (used as f32 / total.max(1) as f32 * 100.0).clamp(0.0, 100.0));
        let gpu_names = if gpu_count > 0 { vec![format!("NVIDIA GPU ×{gpu_count}")] } else { Vec::new() };
        Some(json!({"id": name, "name": metadata.get("labels").and_then(|l| l.get("kubernetes.io/hostname")).cloned().unwrap_or(json!(name)), "role": role, "status": if ready {"ready"} else {"not_ready"}, "cpuCores": cpu, "memoryBytes": memory, "cpuUsedCores": cpu_used, "memoryUsedBytes": memory_used, "gpuNames": gpu_names, "cpuPercent": cpu_percent, "memoryPercent": memory_percent}))
    }).collect::<Vec<_>>();
    let ready = !nodes.is_empty() && nodes.iter().all(|node| node.get("status").and_then(Value::as_str) == Some("ready"));
    Ok(json!({"id": cluster_id, "status": if ready {"ready"} else if nodes.is_empty() {"disconnected"} else {"degraded"}, "capturedAt": peer::now_iso(), "metricsAvailable": metrics_error.is_none(), "metricsError": metrics_error, "nodes": nodes}))
}

#[tauri::command(rename_all = "camelCase")]
async fn get_session_connection_status(session_id: String) -> Result<Value, String> {
    if let Some(progress) = SESSION_PROGRESS.get_or_init(|| Mutex::new(HashMap::new())).lock().map_err(|_| "Session progress state is unavailable.")?.get(&session_id).cloned() {
        if matches!(progress.get("status").and_then(Value::as_str), Some("connecting" | "failed")) { return Ok(progress); }
    }
    let active = ACTIVE_COMPUTE_SESSION.get_or_init(|| Mutex::new(None)).lock().map_err(|_| "Session state is unavailable.")?.clone().ok_or("No active compute session is recorded on this laptop.")?;
    if active.get("sessionId").and_then(Value::as_str) != Some(session_id.as_str()) { return Err("Compute session was not found.".into()); }
    let snapshot = get_cluster_snapshot(Some(SHARED_CLUSTER_ID.into())).await?;
    let ready_nodes = snapshot.get("nodes").and_then(Value::as_array).cloned().unwrap_or_default().iter().filter(|node| node.get("status").and_then(Value::as_str) == Some("ready")).count();
    let expected = active.get("providers").and_then(Value::as_array).map(Vec::len).unwrap_or(0) + 1;
    let status = if ready_nodes == expected { "ready" } else { "failed" };
    let stages = vec![
        json!({"id":"docker","label":"Docker-backed K3s server","status":"completed","detail":K3S_SERVER_CONTAINER}),
        json!({"id":"netbird","label":"Provider workers over NetBird","status":if ready_nodes == expected {"completed"} else {"failed"},"detail":format!("{ready_nodes}/{expected} nodes ready")}),
        json!({"id":"cluster","label":"Kubernetes node readiness","status":if ready_nodes == expected {"completed"} else {"failed"},"detail":format!("{ready_nodes}/{expected} nodes ready")})
    ];
    Ok(json!({"sessionId":session_id,"clusterId":SHARED_CLUSTER_ID,"status":status,"stages":stages,"error":if status == "failed" {Some(format!("Only {ready_nodes} of {expected} Kubernetes nodes are Ready. Check provider Docker and NetBird connectivity."))} else {None}}))
}

#[tauri::command(rename_all = "camelCase")]
async fn end_compute_session(cluster_id: String) -> Result<(), String> {
    if cluster_id != SHARED_CLUSTER_ID { return Err("Unknown ComputePool cluster.".into()); }
    let state = ACTIVE_COMPUTE_SESSION.get_or_init(|| Mutex::new(None)).lock().map_err(|_| "Session state is unavailable.")?.clone().ok_or("No active compute session is recorded on this laptop.")?;
    let mut cleanup_errors = Vec::new();
    if let Some(providers) = state.get("providers").and_then(Value::as_array) {
        if let Ok(token) = current_id_token().await {
            for provider_session in providers {
                let profile = provider_session.get("provider").cloned().unwrap_or(Value::Null);
                if let Err(error) = peer::remote_service_action(&profile, &token, "cluster/leave", json!({"sessionId":state.get("sessionId").and_then(Value::as_str).unwrap_or("")})).await { cleanup_errors.push(error); }
            }
        } else { cleanup_errors.push("Could not refresh Cognito credentials to stop provider worker containers.".into()); }
    }
    let negotiation_ids = state.get("negotiationIds").cloned().unwrap_or(json!([]));
    if let Err(error) = computepool_api("DELETE", "/sessions/netbird", Some(json!({"negotiationIds": negotiation_ids}))).await { cleanup_errors.push(format!("Could not revoke the temporary NetBird access rule: {error}")); }
    match docker_output(&["rm", "-f", K3S_SERVER_CONTAINER]) {
        Some(output) if output.status.success() => {},
        Some(output) => cleanup_errors.push(format!("Could not stop K3s: {}", output_text(&output))),
        None => cleanup_errors.push("Could not reach Docker Desktop to stop the K3s server.".into()),
    }
    if let Some(output) = docker_output(&["volume", "rm", "cp-k3s-state"]) {
        if !output.status.success() && !output_text(&output).to_lowercase().contains("no such volume") { cleanup_errors.push(format!("Could not remove K3s data volume: {}", output_text(&output))); }
    }
    if cleanup_errors.is_empty() {
        *ACTIVE_COMPUTE_SESSION.get_or_init(|| Mutex::new(None)).lock().map_err(|_| "Session state is unavailable.")? = None;
        Ok(())
    } else {
        Err(cleanup_errors.join("; "))
    }
}

fn kubectl_with_input(args: &[&str], body: &[u8]) -> Result<Output, String> {
    use std::io::Write;
    let mut command = hidden_command("docker.exe");
    command.args(["exec", "-i", K3S_SERVER_CONTAINER, "kubectl"]);
    command.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(not(windows))]
    { command = hidden_command("docker"); command.args(["exec", "-i", K3S_SERVER_CONTAINER, "kubectl"]).args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()); }
    let mut child = command.spawn().map_err(|e| format!("Could not start kubectl: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() { stdin.write_all(body).map_err(|e| format!("Could not send workload specification: {e}"))?; }
    child.wait_with_output().map_err(|e| format!("Could not read kubectl result: {e}"))
}

fn safe_job_name(value: &str) -> bool { !value.is_empty() && value.len() <= 50 && value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') }

fn archive_folder(path: &str) -> Result<Vec<u8>, String> {
    fn measure(path: &Path) -> Result<u64, String> {
        let metadata = std::fs::symlink_metadata(path).map_err(|e| format!("Could not inspect input folder: {e}"))?;
        if metadata.file_type().is_symlink() { return Ok(0); }
        if metadata.is_file() { return Ok(metadata.len()); }
        let mut size = 0_u64;
        if metadata.is_dir() { for entry in std::fs::read_dir(path).map_err(|e| format!("Could not read input folder: {e}"))? { size = size.saturating_add(measure(&entry.map_err(|e| format!("Could not read input entry: {e}"))?.path())?); if size > 268_435_456 { return Err("Input folder exceeds the 256 MiB transfer limit.".into()); } } }
        Ok(size)
    }
    if measure(Path::new(path))? > 268_435_456 { return Err("Input folder exceeds the 256 MiB transfer limit.".into()); }
    let output = hidden_command("tar.exe").args(["-czf", "-", "-C", path, "."]).output()
        .or_else(|_| hidden_command("tar").args(["-czf", "-", "-C", path, "."]).output())
        .map_err(|e| format!("Could not archive input folder: {e}"))?;
    if !output.status.success() { return Err(format!("Could not archive input folder: {}", output_text(&output))); }
    if output.stdout.is_empty() || output.stdout.len() > 268_435_456 { return Err("Input folder archive must be between 1 byte and 256 MiB.".into()); }
    Ok(output.stdout)
}

fn extract_archive_safely(archive: &[u8], destination: &str) -> Result<(), String> {
    use std::io::Write;
    std::fs::create_dir_all(destination).map_err(|e| format!("Could not create output folder: {e}"))?;
    let mut list = hidden_command("tar.exe").args(["-tzf", "-"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
        .or_else(|_| hidden_command("tar").args(["-tzf", "-"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn())
        .map_err(|e| format!("Could not inspect output archive: {e}"))?;
    if let Some(mut stdin) = list.stdin.take() { stdin.write_all(archive).map_err(|e| format!("Could not inspect output archive: {e}"))?; }
    let listing = list.wait_with_output().map_err(|e| format!("Could not inspect output archive: {e}"))?;
    if !listing.status.success() { return Err(format!("Provider returned an invalid tar archive: {}", output_text(&listing))); }
    for entry in String::from_utf8_lossy(&listing.stdout).lines() {
        let path = Path::new(entry.trim());
        if path.is_absolute() || path.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::Prefix(_))) { return Err("Provider output archive contains an unsafe path and was rejected.".into()); }
    }
    let mut types = hidden_command("tar.exe").args(["-tvzf", "-"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
        .or_else(|_| hidden_command("tar").args(["-tvzf", "-"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn())
        .map_err(|e| format!("Could not inspect output archive entries: {e}"))?;
    if let Some(mut stdin) = types.stdin.take() { stdin.write_all(archive).map_err(|e| format!("Could not inspect output archive entries: {e}"))?; }
    let listing = types.wait_with_output().map_err(|e| format!("Could not inspect output archive entries: {e}"))?;
    if !listing.status.success() { return Err(format!("Could not inspect output archive entries: {}", output_text(&listing))); }
    if String::from_utf8_lossy(&listing.stdout).lines().any(|entry| !entry.starts_with('-') && !entry.starts_with('d')) { return Err("Provider output contains links or special files and was rejected.".into()); }
    let mut extract = hidden_command("tar.exe").args(["-xzf", "-", "-C", destination]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
        .or_else(|_| hidden_command("tar").args(["-xzf", "-", "-C", destination]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn())
        .map_err(|e| format!("Could not extract provider output: {e}"))?;
    if let Some(mut stdin) = extract.stdin.take() { stdin.write_all(archive).map_err(|e| format!("Could not extract provider output: {e}"))?; }
    let result = extract.wait_with_output().map_err(|e| format!("Could not extract provider output: {e}"))?;
    if !result.status.success() { return Err(format!("Could not extract provider output: {}", output_text(&result))); }
    Ok(())
}

fn extract_local_input(archive: &[u8], workspace: &str, job: &str) -> Result<(), String> {
    let destination = Path::new(workspace).join("jobs").join(job).join("input");
    std::fs::create_dir_all(&destination).map_err(|e| format!("Could not create consumer input mount: {e}"))?;
    use std::io::Write;
    let destination = destination.to_string_lossy().into_owned();
    let mut child = hidden_command("tar.exe").args(["-xzf", "-", "-C", &destination]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
        .or_else(|_| hidden_command("tar").args(["-xzf", "-", "-C", &destination]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn())
        .map_err(|e| format!("Could not stage input on the consumer node: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() { stdin.write_all(archive).map_err(|e| format!("Could not stage consumer input: {e}"))?; }
    let result = child.wait_with_output().map_err(|e| format!("Could not stage consumer input: {e}"))?;
    if !result.status.success() { return Err(format!("Could not unpack input on the consumer node: {}", output_text(&result))); }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn list_batch_jobs(cluster_id: String) -> Result<Vec<Value>, String> {
    if cluster_id != SHARED_CLUSTER_ID { return Err("Batch workloads run on the active shared ComputePool cluster.".into()); }
    let output = server_kubectl(&["get", "jobs", "--all-namespaces", "-l", "app.kubernetes.io/managed-by=computepool", "-o", "json"]).ok_or("Docker is unavailable.")?;
    if !output.status.success() { return Err(format!("Could not read Kubernetes jobs: {}", output_text(&output))); }
    let data: Value = serde_json::from_slice(&output.stdout).map_err(|e| format!("Kubernetes returned invalid job data: {e}"))?;
    let mut jobs: Vec<Value> = data.pointer("/items").and_then(Value::as_array).into_iter().flatten().map(|job| {
        let meta = &job["metadata"];
        let spec = &job["spec"];
        let status = &job["status"];
        let name = meta["name"].as_str().unwrap_or_default();
        let completed = status["succeeded"].as_u64().unwrap_or(0);
        let total = spec["completions"].as_u64().unwrap_or(1).max(1);
        let phase = if status["failed"].as_u64().unwrap_or(0) > 0 { "failed" } else if completed >= total { "completed" } else if status["active"].as_u64().unwrap_or(0) > 0 { "running" } else { "queued" };
        let selector = spec.pointer("/template/spec/affinity/nodeAffinity/requiredDuringSchedulingIgnoredDuringExecution/nodeSelectorTerms/0/matchExpressions/0/values").cloned().unwrap_or(json!([]));
        json!({"id":name,"name":meta.pointer("/annotations/computepool.io~1display-name").and_then(Value::as_str).unwrap_or(name),"image":job.pointer("/spec/template/spec/containers/0/image").and_then(Value::as_str).unwrap_or_default(),"imagePullPolicy":job.pointer("/spec/template/spec/containers/0/imagePullPolicy"),"status":phase,"nodeIds":selector,"cpuCores":job.pointer("/spec/template/spec/containers/0/resources/requests/cpu").and_then(Value::as_str).unwrap_or("1").parse::<f32>().unwrap_or(1.0),"memoryBytes":job.pointer("/spec/template/spec/containers/0/resources/requests/memory").and_then(Value::as_str).map(|s| parse_quantity_bytes(s).unwrap_or(0)).unwrap_or(0),"gpuCount":job.pointer("/spec/template/spec/containers/0/resources/requests/nvidia.com~1gpu").and_then(Value::as_str).and_then(|v|v.parse::<u32>().ok()).unwrap_or(0),"replicas":spec["parallelism"],"createdAt":meta["creationTimestamp"],"progressPercent":(completed.saturating_mul(100)/total).min(100),"error":status.pointer("/conditions/0/message")})
    }).collect();
    // Job state alone says whether work is queued or complete, but not why a
    // pod is waiting or which worker received it. Read the controller pods on
    // each live refresh so the UI can show scheduling and image-pull progress.
    if let Some(pods_output) = server_kubectl(&["get", "pods", "--all-namespaces", "-l", "app.kubernetes.io/managed-by=computepool", "-o", "json"]) {
        if pods_output.status.success() {
            if let Ok(pod_data) = serde_json::from_slice::<Value>(&pods_output.stdout) {
                let all_pods = pod_data.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
                let event_items = server_kubectl(&["get", "events", "-n", "default", "-o", "json"])
                    .filter(|output| output.status.success())
                    .and_then(|output| serde_json::from_slice::<Value>(&output.stdout).ok())
                    .and_then(|data| data.get("items").and_then(Value::as_array).cloned())
                    .unwrap_or_default();
                for job in &mut jobs {
                    let id = job["id"].as_str().unwrap_or_default();
                    let matched = all_pods.iter().filter(|pod| pod.pointer("/metadata/labels/job-name").and_then(Value::as_str) == Some(id)).map(|pod| {
                        let statuses = pod.pointer("/status/containerStatuses").and_then(Value::as_array).cloned().unwrap_or_default();
                        let waiting = statuses.iter().find_map(|status| status.pointer("/state/waiting").filter(|value| !value.is_null()));
                        let terminated = statuses.iter().find_map(|status| status.pointer("/state/terminated").filter(|value| !value.is_null()));
                        let ready = pod.pointer("/status/conditions").and_then(Value::as_array).into_iter().flatten().any(|condition| condition.get("type").and_then(Value::as_str) == Some("Ready") && condition.get("status").and_then(Value::as_str) == Some("True"));
                        let phase = pod.pointer("/status/phase").and_then(Value::as_str).unwrap_or("Unknown");
                        let reason = waiting.and_then(|state| state.get("reason")).and_then(Value::as_str)
                            .or_else(|| terminated.and_then(|state| state.get("reason")).and_then(Value::as_str))
                            .or_else(|| pod.pointer("/status/reason").and_then(Value::as_str)).unwrap_or(phase);
                        let detail = waiting.and_then(|state| state.get("message")).and_then(Value::as_str)
                            .or_else(|| terminated.and_then(|state| state.get("message")).and_then(Value::as_str))
                            .or_else(|| pod.pointer("/status/message").and_then(Value::as_str));
                        let restarts = statuses.iter().filter_map(|status| status.get("restartCount").and_then(Value::as_u64)).sum::<u64>();
                        let pod_name = pod.pointer("/metadata/name").and_then(Value::as_str).unwrap_or_default();
                        let pod_ref = format!("pod/{pod_name}");
                        let log_output = server_kubectl(&["logs", &pod_ref, "--all-containers=true", "--tail=60", "--timestamps=true", "-n", "default"])
                            .filter(|output| output.status.success() && !output.stdout.is_empty())
                            .or_else(|| if restarts > 0 { server_kubectl(&["logs", &pod_ref, "--all-containers=true", "--previous", "--tail=60", "--timestamps=true", "-n", "default"]).filter(|output| output.status.success()) } else { None });
                        let logs = log_output.map(|output| String::from_utf8_lossy(&output.stdout).chars().rev().take(16_000).collect::<String>().chars().rev().collect::<String>());
                        let events = event_items.iter().filter(|event| event.pointer("/involvedObject/name").and_then(Value::as_str) == Some(pod_name)).rev().take(8).map(|event| {
                            let event_type = event.get("type").and_then(Value::as_str).unwrap_or("Normal");
                            let event_reason = event.get("reason").and_then(Value::as_str).unwrap_or("Event");
                            let count = event.get("count").and_then(Value::as_u64).filter(|count| *count > 1).map(|count| format!(" (x{count})")).unwrap_or_default();
                            let message = event.get("message").and_then(Value::as_str).unwrap_or_default();
                            format!("{event_type} · {event_reason}{count}: {message}")
                        }).collect::<Vec<_>>();
                        json!({"name":pod.pointer("/metadata/name").cloned().unwrap_or(Value::Null),"phase":phase,"nodeName":pod.pointer("/spec/nodeName").cloned().unwrap_or(Value::Null),"ready":ready,"reason":reason,"detail":detail,"restartCount":restarts,"logs":logs,"events":events,"imagePullPolicy":pod.pointer("/spec/containers/0/imagePullPolicy")})
                    }).collect::<Vec<_>>();
                    job["pods"] = json!(matched);
                }
            }
        }
    }
    let id_token = current_id_token().await.ok();
    if let Some(token) = id_token {
        for job in jobs.iter_mut().filter(|job| job["status"] == "completed") {
                let id = job["id"].as_str().unwrap_or_default().to_string();
                if JOB_OUTPUT_SYNCED.get_or_init(|| Mutex::new(std::collections::HashSet::new())).lock().map_err(|_| "Output sync state is unavailable.")?.contains(&id) { job["outputSync"] = json!("completed"); continue; }
                let target = JOB_OUTPUT_TARGETS.get_or_init(|| Mutex::new(HashMap::new())).lock().ok().and_then(|targets| targets.get(&id).cloned());
                let Some(target) = target else { continue; };
                let output_path = target["outputFolder"].as_str().unwrap_or_default();
                let mut errors = Vec::new();
                for (index, node) in target["nodes"].as_array().into_iter().flatten().enumerate() {
                    let node_name = node["nodeName"].as_str().unwrap_or("node");
                    let child = Path::new(output_path).join(format!("{}-{}", index + 1, node_name));
                    let archive = if let Some(provider) = node.get("provider") { peer::download_output(provider, &token, target["sessionId"].as_str().unwrap_or_default(), &id).await }
                    else {
                        let mounted = format!("/workspace/jobs/{id}/output");
                        let out = docker_output(&["exec", K3S_SERVER_CONTAINER, "tar", "-czf", "-", "-C", &mounted, "."]).ok_or("Could not read consumer-node outputs.")?;
                        if out.status.success() { Ok(out.stdout) } else { Err(format!("Could not collect consumer-node outputs: {}", output_text(&out))) }
                    };
                    match archive { Ok(bytes) => if let Err(error) = extract_archive_safely(&bytes, &child.to_string_lossy()) { errors.push(error); }, Err(error) => errors.push(error) }
                }
                if errors.is_empty() { JOB_OUTPUT_SYNCED.get_or_init(|| Mutex::new(std::collections::HashSet::new())).lock().map_err(|_| "Output sync state is unavailable.")?.insert(id); job["outputSync"] = json!("completed"); }
                else { job["outputSync"] = json!("failed"); job["error"] = json!(errors.join("; ")); }
        }
    }
    Ok(jobs)
}

#[tauri::command(rename_all = "camelCase")]
async fn submit_batch_job(cluster_id: String, spec: Value) -> Result<Value, String> {
    if cluster_id != SHARED_CLUSTER_ID { return Err("Batch workloads run on the active shared ComputePool cluster.".into()); }
    let name = spec["name"].as_str().unwrap_or_default().trim().to_lowercase().replace('_', "-");
    let image = spec["image"].as_str().unwrap_or_default().trim();
    let command = spec["command"].as_str().unwrap_or_default();
    let cpu = spec["cpuCores"].as_u64().unwrap_or(0);
    let memory = spec["memoryBytes"].as_u64().unwrap_or(0);
    let gpu = spec["gpuCount"].as_u64().unwrap_or(0);
    let replicas = spec["replicas"].as_u64().unwrap_or(0);
    let nodes = spec["nodeIds"].as_array().ok_or("Select at least one ready provider node.")?.iter().filter_map(Value::as_str).map(ToOwned::to_owned).collect::<Vec<_>>();
    if !safe_job_name(&name) || image.is_empty() || image.chars().any(char::is_whitespace) { return Err("Enter a valid workload name and container image.".into()); }
    if cpu == 0 || cpu > 256 || memory < 1024*1024*1024 || gpu > 32 || replicas == 0 || replicas > 256 || nodes.is_empty() { return Err("Workload resources, pod count, or node selection is outside the supported range.".into()); }
    if !Path::new(spec["inputFolder"].as_str().unwrap_or_default()).is_dir() || !Path::new(spec["outputFolder"].as_str().unwrap_or_default()).is_dir() { return Err("Choose existing input and output folders.".into()); }
    let active = ACTIVE_COMPUTE_SESSION.get_or_init(|| Mutex::new(None)).lock().map_err(|_| "Session state is unavailable.")?.clone().ok_or("No active ComputePool session is available.")?;
    if active.get("clusterId").and_then(Value::as_str) != Some(cluster_id.as_str()) { return Err("The active ComputePool session does not match this cluster.".into()); }
    let snapshot = get_cluster_snapshot(Some(cluster_id.clone())).await?;
    let ready = snapshot["nodes"].as_array().into_iter().flatten().filter(|n| n["status"] == "ready").filter_map(|n| n["id"].as_str()).collect::<Vec<_>>();
    if nodes.iter().any(|id| !ready.contains(&id.as_str())) { return Err("A selected node is no longer ready. Refresh the dashboard and choose live nodes.".into()); }
    if gpu > 0 && cluster_gpu_capacity(&cluster_id, Some(&nodes))? < gpu as u32 {
        return Err("The selected nodes do not advertise enough schedulable NVIDIA GPUs. K3s GPU device-plugin scheduling is not configured in this build.".into());
    }
    let id = format!("cp-job-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let input_archive = archive_folder(spec["inputFolder"].as_str().unwrap_or_default())?;
    let session_id = active["sessionId"].as_str().ok_or("ComputePool session ID is missing.")?;
    let workspace = active["workspace"].as_str().ok_or("Consumer workspace mount is missing.")?;
    let providers = active["providers"].as_array().cloned().unwrap_or_default();
    let mut output_nodes = Vec::new();
    for node_id in &nodes {
        if snapshot["nodes"].as_array().into_iter().flatten().any(|n| n["id"].as_str() == Some(node_id.as_str()) && n["role"] == "control-plane") {
            extract_local_input(&input_archive, workspace, &id)?;
            std::fs::create_dir_all(Path::new(workspace).join("jobs").join(&id).join("output")).map_err(|e| format!("Could not create consumer output mount: {e}"))?;
            output_nodes.push(json!({"nodeName":node_id,"provider":null}));
        } else {
            let provider_session = providers.iter().find(|p| p["node"].as_str() == Some(node_id.as_str())).ok_or_else(|| format!("Provider node {node_id} has no active peer transfer route."))?;
            let provider = provider_session.get("provider").cloned().ok_or("Provider transfer identity is missing.")?;
            peer::upload_input(&provider, &current_id_token().await?, session_id, &id, input_archive.clone()).await?;
            output_nodes.push(json!({"nodeName":node_id,"provider":provider}));
        }
    }
    let mut requests = json!({"cpu":cpu.to_string(),"memory":format!("{}Mi",memory.div_ceil(1024*1024))});
    if gpu > 0 { requests["nvidia.com/gpu"] = json!(gpu.to_string()); }
    if command.trim().is_empty() { return Err("Enter a command or training entrypoint before launching the workload.".into()); }
    let args = vec!["sh".to_string(), "-lc".to_string(), format!("mkdir -p /workspace/jobs/{id}/output && {command}")];
    let input_dir = format!("/workspace/jobs/{id}/input"); let output_dir = format!("/workspace/jobs/{id}/output");
    // Make pull behavior explicit: mutable/unpinned references are checked at
    // every start; version tags and digests reuse a cached immutable image.
    let image_without_digest = image.split('@').next().unwrap_or(image);
    let last_component = image_without_digest.rsplit('/').next().unwrap_or(image_without_digest);
    let tag = last_component.rsplit_once(':').map(|(_, tag)| tag);
    let image_pull_policy = if tag.is_none() || tag == Some("latest") { "Always" } else { "IfNotPresent" };
    let manifest = json!({"apiVersion":"batch/v1","kind":"Job","metadata":{"name":id,"namespace":"default","labels":{"app.kubernetes.io/managed-by":"computepool"},"annotations":{"computepool.io/display-name":name}},"spec":{"parallelism":replicas,"completions":replicas,"backoffLimit":0,"template":{"metadata":{"labels":{"app.kubernetes.io/managed-by":"computepool","job-name":id}},"spec":{"restartPolicy":"Never","affinity":{"nodeAffinity":{"requiredDuringSchedulingIgnoredDuringExecution":{"nodeSelectorTerms":[{"matchExpressions":[{"key":"kubernetes.io/hostname","operator":"In","values":nodes}]}]}}},"containers":[{"name":"worker","image":image,"imagePullPolicy":image_pull_policy,"command":args,"env":[{"name":"COMPUTEPOOL_INPUT_DIR","value":input_dir},{"name":"COMPUTEPOOL_OUTPUT_DIR","value":output_dir}],"resources":{"requests":requests,"limits":requests},"volumeMounts":[{"name":"workspace","mountPath":"/workspace"}]}],"volumes":[{"name":"workspace","hostPath":{"path":"/workspace","type":"Directory"}}]}}}});
    let bytes = serde_json::to_vec(&manifest).map_err(|e| format!("Could not prepare Kubernetes workload: {e}"))?;
    let output = kubectl_with_input(&["apply","-f","-"], &bytes)?;
    if !output.status.success() { return Err(format!("Kubernetes rejected the workload: {}", output_text(&output))); }
    JOB_OUTPUT_TARGETS.get_or_init(|| Mutex::new(HashMap::new())).lock().map_err(|_| "Output sync state is unavailable.")?.insert(id.clone(), json!({"outputFolder":spec["outputFolder"],"nodes":output_nodes,"sessionId":session_id,"workspace":workspace}));
    let job = json!({"id":id,"name":name,"image":image,"imagePullPolicy":image_pull_policy,"status":"queued","nodeIds":nodes,"cpuCores":cpu,"memoryBytes":memory,"gpuCount":gpu,"replicas":replicas,"createdAt":peer::now_iso(),"progressPercent":0,"outputSync":"pending"});
    Ok(job)
}

#[tauri::command(rename_all = "camelCase")]
async fn cancel_batch_job(job_id: String) -> Result<(), String> {
    if !job_id.starts_with("cp-job-") || !safe_job_name(&job_id) { return Err("Invalid ComputePool job identifier.".into()); }
    let output = server_kubectl(&["delete","job",&job_id,"--ignore-not-found=true","--wait=false"]).ok_or("Docker is unavailable.")?;
    if !output.status.success() { return Err(format!("Could not cancel Kubernetes job: {}", output_text(&output))); }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(15)).await;
                    if peer::local_profile().get("online").and_then(Value::as_bool) == Some(true) {
                        if let Err(error) = get_provider_status().await {
                            eprintln!("Provider background heartbeat failed: {error}");
                        }
                    }
                }
            });
            let _ = app;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Cognito's hosted-login webview closes itself after returning the
            // OAuth callback. Only closing the main app window should stop
            // provider sharing and terminate the desktop process.
            if window.label() != "main" { return; }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if CLOSE_PENDING.swap(true, Ordering::SeqCst) { return; }
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut still_connecting = false;
                    for _ in 0..300 {
                        still_connecting = SESSION_PROGRESS.get_or_init(|| Mutex::new(HashMap::new())).lock()
                            .map(|sessions| sessions.values().any(|value| value.get("status").and_then(Value::as_str) == Some("connecting")))
                            .unwrap_or(false);
                        if !still_connecting { break; }
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                    // Keep the app and its progress view alive rather than exit halfway
                    // through worker provisioning and strand a remote container.
                    if still_connecting { CLOSE_PENDING.store(false, Ordering::SeqCst); return; }
                    let has_consumer_session = ACTIVE_COMPUTE_SESSION.get_or_init(|| Mutex::new(None)).lock().map(|state| state.is_some()).unwrap_or(false);
                    if has_consumer_session {
                        let _ = tokio::time::timeout(Duration::from_secs(180), end_compute_session(SHARED_CLUSTER_ID.into())).await;
                        // The session's local Docker control plane must not keep running if the network/API cleanup timed out.
                        let _ = docker_output(&["rm", "-f", K3S_SERVER_CONTAINER]);
                        let _ = docker_output(&["volume", "rm", "cp-k3s-state"]);
                    }
                    mark_provider_offline_on_exit().await;
                    let _ = peer::shutdown_workers();
                    app.exit(0);
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_hardware,
            check_dependencies,
            install_dependency,
            verify_dependency,
            get_netbird_status,
            connect_netbird,
            list_netbird_peers,
            open_pod_shell,
            execute_pod_shell_command,
            list_running_pods,
            create_interactive_pod,
            open_node_shell,
            execute_node_shell_command,
            get_auth_status,
            open_cognito_login,
            cognito_sign_out,
            list_available_providers,
            get_provider_details,
            list_negotiations,
            get_negotiation_messages,
            get_negotiation_messages_by_id,
            send_negotiation_message,
            send_negotiation_message_by_id,
            send_resource_proposal,
            decide_resource_proposal,
            close_negotiation_request,
            start_resource_request,
            get_provider_status,
            set_provider_limits,
            set_provider_online,
            list_incoming_requests,
            list_provider_sessions,
            list_provider_live_telemetry,
            decide_provider_request,
            get_provider_messages,
            send_provider_message,
            get_cluster_snapshot,
            start_compute_session,
            get_session_connection_status,
            end_compute_session,
            open_node_shell,
            execute_node_shell_command,
            list_batch_jobs,
            submit_batch_job,
            cancel_batch_job
        ])
        .run(tauri::generate_context!())
        .expect("failed to run ComputePool desktop app");
}
