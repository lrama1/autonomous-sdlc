# Deploys the stack to your AWS account. Run from this folder. Needs: Terraform, Docker, the AWS CLI, pnpm.
#   $env:TF_VAR_bootstrap_admin_email = 'you@example.com'      # required: the first admin
#   $env:TF_VAR_openrouter_key_agents = '<key>'                 # optional: the gateway's model key
#   ./deploy.ps1
# State lives in S3 (see ../bootstrap), so your machine and the Deploy workflow can manage the same stack.
# Safe to run again. It builds the platform image and the runner (sandbox) image and pushes both before starting any service.
param([string]$Profile = 'default', [string]$Region = 'us-east-1', [string]$Tag = 'dev')
if ($Profile) { $env:AWS_PROFILE = $Profile } # CI passes -Profile '' and uses the credentials in the environment
$env:TF_VAR_aws_profile = $Profile
$root = Resolve-Path (Join-Path $PSScriptRoot '../..')

# Native tools write warnings to stderr, so success is judged by the exit code, not by the error stream.
function Run([scriptblock]$cmd) {
  & $cmd
  if ($LASTEXITCODE -ne 0) { throw "failed (exit $LASTEXITCODE): $cmd" }
}

. "$PSScriptRoot/tf-init.ps1"
Initialize-Terraform $Region
# 1. The image repository first, so there is somewhere to push to. No service runs yet.
Run { terraform apply -input=false -auto-approve '-target=aws_ecr_repository.platform' '-target=aws_ecr_repository.runner' -var "desired_count=0" -var "image_tag=$Tag" }
$repo = terraform output -raw ecr_repository
$runnerRepo = terraform output -raw runner_ecr_repository
$registry = $repo.Split('/')[0]

# 2. Build and push.
aws ecr get-login-password --region $Region | docker login --username AWS --password-stdin $registry
if ($LASTEXITCODE -ne 0) { throw 'docker login failed' }
Run { docker build -t "${repo}:$Tag" $root }
Run { docker push "${repo}:$Tag" }

# 2b. The runner image: the sandbox every agent run starts from, and the egress proxy.
Push-Location $root
try { Run { pnpm --filter '@sdlc/runner' image } } finally { Pop-Location }
Run { docker tag sdlc-runner:dev "${runnerRepo}:$Tag" }
Run { docker push "${runnerRepo}:$Tag" }

# 3. Everything else.
Run { terraform apply -input=false -auto-approve -var "image_tag=$Tag" }
terraform output
