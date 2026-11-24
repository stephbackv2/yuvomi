param([string]$Gcloud = 'gcloud')
$ErrorActionPreference = 'Stop'

$project = 'self-hosted-yuvomi'
$region = 'us-east1'
$zone = 'us-east1-c'
$instanceId = '6553131111779862529'
$pool = 'yuvomi-github'
$provider = 'github'
$deployAccount = "yuvomi-ci-deploy@$project.iam.gserviceaccount.com"
$bringAccount = "yuvomi-ci-bring@$project.iam.gserviceaccount.com"

function Invoke-Gcp {
    & $Gcloud @args
    if ($LASTEXITCODE -ne 0) { throw 'Google Cloud setup command failed' }
}

Invoke-Gcp services enable artifactregistry.googleapis.com secretmanager.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com iap.googleapis.com --project=$project --quiet
$number = Invoke-Gcp projects describe $project '--format=value(projectNumber)'
$poolResource = "projects/$number/locations/global/workloadIdentityPools/$pool"
$condition = "assertion.repository_id == '1402783846' && assertion.repository_owner_id == '115625918' && assertion.ref == 'refs/heads/codex/household-customizations' && assertion.workflow_ref == 'stephbackv2/yuvomi/.github/workflows/gcp.yml@refs/heads/codex/household-customizations' && assertion.environment in ['gcp-production', 'gcp-bring']"

$repositories = @(Invoke-Gcp artifacts repositories list --location=$region --project=$project '--format=value(name.basename())')
if ('yuvomi' -notin $repositories) {
    Invoke-Gcp artifacts repositories create yuvomi --repository-format=docker --location=$region --project=$project --quiet
}
$pools = @(Invoke-Gcp iam workload-identity-pools list --location=global --project=$project '--format=value(name.basename())')
if ($pool -notin $pools) {
    Invoke-Gcp iam workload-identity-pools create $pool --location=global '--display-name=Yuvomi GitHub Actions' --project=$project --quiet
}
$providers = @(Invoke-Gcp iam workload-identity-pools providers list --workload-identity-pool=$pool --location=global --project=$project '--format=value(name.basename())')
if ($provider -notin $providers) {
    Invoke-Gcp iam workload-identity-pools providers create-oidc $provider --workload-identity-pool=$pool --location=global '--issuer-uri=https://token.actions.githubusercontent.com' '--attribute-mapping=google.subject=assertion.sub,attribute.environment=assertion.environment' --attribute-condition=$condition --project=$project --quiet
}

$accounts = @(Invoke-Gcp iam service-accounts list --project=$project '--format=value(email)')
foreach ($account in @($deployAccount, $bringAccount)) {
    if ($account -notin $accounts) {
        Invoke-Gcp iam service-accounts create ($account.Split('@')[0]) --project=$project --quiet
    }
    $environment = if ($account -eq $deployAccount) { 'gcp-production' } else { 'gcp-bring' }
    Invoke-Gcp iam service-accounts add-iam-policy-binding $account "--member=principalSet://iam.googleapis.com/$poolResource/attribute.environment/$environment" --role=roles/iam.workloadIdentityUser --project=$project --quiet --format=none
}

$secrets = @(Invoke-Gcp secrets list --project=$project '--format=value(name.basename())')
foreach ($secret in @('yuvomi-runtime', 'yuvomi-deploy-ssh', 'yuvomi-bring')) {
    if ($secret -notin $secrets) {
        Invoke-Gcp secrets create $secret --replication-policy=automatic --project=$project --quiet --format=none
    }
    $account = if ($secret -eq 'yuvomi-bring') { $bringAccount } else { $deployAccount }
    Invoke-Gcp secrets add-iam-policy-binding $secret "--member=serviceAccount:$account" --role=roles/secretmanager.secretAccessor --project=$project --quiet --format=none
}

Invoke-Gcp artifacts repositories add-iam-policy-binding yuvomi --location=$region "--member=serviceAccount:$deployAccount" --role=roles/artifactregistry.writer --project=$project --quiet --format=none
$lookupRole = 'yuvomiIapComputeLookup'
$roles = @(Invoke-Gcp iam roles list --project=$project '--format=value(name.basename())')
if ($lookupRole -notin $roles) {
    Invoke-Gcp iam roles create $lookupRole '--title=Yuvomi IAP Compute lookup' '--permissions=compute.instances.get,compute.instances.list' --stage=GA --project=$project --quiet --format=none
}
Invoke-Gcp projects add-iam-policy-binding $project "--member=serviceAccount:$deployAccount" "--role=projects/$project/roles/$lookupRole" --condition=None --quiet --format=none

$iapResource = "https://iap.googleapis.com/v1/projects/$number/iap_tunnel/zones/$zone/instances/$instanceId"
$headers = @{ Authorization = 'Bearer ' + (Invoke-Gcp auth print-access-token) }
$policy = Invoke-RestMethod -Method Post -Uri "${iapResource}:getIamPolicy" -Headers $headers -ContentType 'application/json' -Body '{"options":{"requestedPolicyVersion":3}}'
$binding = @{
    role = 'roles/iap.tunnelResourceAccessor'
    members = @("serviceAccount:$deployAccount")
    condition = @{ title = 'Yuvomi CI SSH'; expression = 'destination.port == 22' }
}
if (-not ($policy.bindings | Where-Object {
    $_.role -eq $binding.role -and $binding.members[0] -in $_.members -and $_.condition.expression -eq $binding.condition.expression
})) {
    $bindings = @($policy.bindings | Where-Object { $_ }) + @($binding)
    $body = @{ policy = @{ version = 3; etag = $policy.etag; bindings = $bindings } }
    Invoke-RestMethod -Method Post -Uri "${iapResource}:setIamPolicy" -Headers $headers -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 10) | Out-Null
}

Write-Output "GCP_WORKLOAD_IDENTITY_PROVIDER = $poolResource/providers/$provider"
Write-Output "gcp-production GCP_SERVICE_ACCOUNT = $deployAccount"
Write-Output "gcp-bring GCP_SERVICE_ACCOUNT = $bringAccount"
