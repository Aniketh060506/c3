# ComputePool AWS Console setup (no SAM)

This setup uses the AWS Console, existing DynamoDB tables, one Lambda function, API Gateway HTTP API, and EventBridge Scheduler. The NetBird token is supplied as a Lambda environment variable, so it does not create a Secrets Manager secret. Environment variables are encrypted at rest, but IAM users who can inspect the Lambda configuration can read the token. Restrict Lambda/IAM access.

**Zero cost is not guaranteed.** Lambda and EventBridge Scheduler have free allowances; API Gateway's introductory free allowance is time-limited. DynamoDB tables may also incur charges according to their billing mode and use. An online provider sends recurring heartbeat and negotiation requests while ComputePool is open; inspect API Gateway, Lambda, and DynamoDB metrics for your actual usage.

## 1. Build the Lambda ZIP

From PowerShell in the project:

```powershell
Set-Location C:\Users\Aniketh\Documents\c3\motion-market-meadow\backend\src
npm install --omit=dev
Compress-Archive -Path app.mjs,package.json,node_modules -DestinationPath ..\computepool-lambda.zip -Force
```

The ZIP root must contain `app.mjs`, `package.json`, and `node_modules`.

## 2. Create the Lambda in AWS Console

1. AWS Console → **Lambda** → **Create function** → **Author from scratch**.
2. Function name: `computepool-marketplace`; runtime: **Node.js 22.x**; architecture: **x86_64**. Create a new execution role with basic Lambda permissions.
3. **Configuration → General configuration → Edit**: memory `256 MB`, timeout `20 seconds`.
4. **Code → Upload from → .zip file**: upload `backend\computepool-lambda.zip`. Under **Runtime settings**, set handler to `app.handler`.
5. **Configuration → Environment variables**: add these keys:

   - `PROVIDERS_TABLE` = `online_providers`
   - `SESSIONS_TABLE` = `sessions`
   - `CONVERSATIONS_TABLE` = `conversations`
   - `MESSAGES_TABLE` = `messages`
   - `NETBIRD_API` = `https://api.netbird.io`
   - `NETBIRD_MANAGEMENT_TOKEN` = your NetBird API token
   - `NETBIRD_ENROLLMENT_GROUP_ID` = blank unless you set up an enrollment group

Do not put the token in this repository, a desktop build, or a chat message.

## 3. Give the Lambda role access to the existing tables

1. Lambda → **Configuration → Permissions** → open the execution role in IAM.
2. **Add permissions → Create inline policy → JSON**. Paste the policy below and save as `ComputePoolMarketplaceTables`:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": ["dynamodb:Scan", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
       "Resource": [
         "arn:aws:dynamodb:ap-south-1:230372904524:table/online_providers",
         "arn:aws:dynamodb:ap-south-1:230372904524:table/sessions",
         "arn:aws:dynamodb:ap-south-1:230372904524:table/conversations",
         "arn:aws:dynamodb:ap-south-1:230372904524:table/messages"
       ]
     }]
   }
   ```

The execution role also needs the AWS managed policy `AWSLambdaBasicExecutionRole` for CloudWatch Logs. If the `/aws/lambda/computepool-marketplace` log group does not exist, open **Lambda → Configuration → Permissions → execution role**, attach this policy, then invoke the function again. Lambda creates the log group on the next invocation.

## 4. Create API Gateway HTTP API

1. API Gateway → **Create API → HTTP API → Build**. Add the Lambda integration `computepool-marketplace`.
2. Create a JWT authorizer:
   - Identity source: `$request.header.Authorization`
   - Issuer: `https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_xAlBWSAWs`
   - Audience: `794gej34ru6dce5b7bqhfu165e`
3. Add each route, set its integration to the Lambda, and select the JWT authorizer:

   | Method | Route |
   | --- | --- |
   | GET | `/providers` |
   | PUT | `/providers/me` |
   | DELETE | `/providers/me` |
   | ANY | `/negotiations` |
   | POST | `/negotiations/{id}/decision` |
   | ANY | `/negotiations/{id}/messages` |
   | POST | `/netbird/setup-key` |
   | POST | `/netbird/verify-peer` |
   | ANY | `/sessions/netbird` |

4. Enable auto-deploy on the API's stage. The existing API `6ysr9qz5a9` uses the `$default` stage, so its base URL is `https://6ysr9qz5a9.execute-api.ap-south-1.amazonaws.com` with no `/prod` suffix. The SAM template below creates a separate `prod` stage; only use `/prod` when that is the stage shown for the API you deployed.

## 5. Schedule expired-session cleanup

1. EventBridge → **Scheduler → Create schedule** → recurring schedule `rate(1 minute)`; flexible time window off.
2. Target the Lambda `computepool-marketplace` and set input to:

   ```json
   {"source":"computepool.cleanup"}
   ```

3. Let Scheduler create its invocation role.

## 6. Configure NetBird once

Use a dedicated ComputePool NetBird workspace. Create a NetBird API token with permission to create one-use setup keys and read peers, groups, and policies, and to create/delete groups and policies. Disable peer approval for setup-key-enrolled peers so enrollment is automatic. Before starting a session, remove or narrow any workspace-wide policy that allows the `All` group. ComputePool refuses to start when it detects such a rule; it does not modify workspace-wide rules. It then creates and deletes a temporary policy for the consumer and accepted providers. Do not use a personal/shared workspace.

## 7. Build the desktop for this API

From the project root:

```powershell
$env:COMPUTEPOOL_API_URL = "https://6ysr9qz5a9.execute-api.ap-south-1.amazonaws.com"
npm run tauri:build
Remove-Item Env:COMPUTEPOOL_API_URL
```

The NSIS installer is under `src-tauri\target\release\bundle\nsis`. Each user installs NetBird and ComputePool and signs in to ComputePool with Cognito only. No NetBird user account or per-session invite is required.
