# Windows PowerShell equivalent of mysql-public-ip.sh.
# Prints the current public IP of the running mysql Fargate task, for pasting
# into .env's DB_HOST. Fargate assigns a new ENI (and public IP) on every
# task restart, so there is no fixed address to hardcode.
param(
  [string]$Profile = ""
)

$ErrorActionPreference = "Stop"

$Cluster = "onestage-cluster"
$Region = "ap-southeast-1"
$ProfileArgs = if ($Profile) { @("--profile", $Profile) } else { @() }

$taskArn = aws ecs list-tasks @ProfileArgs --region $Region --cluster $Cluster --service-name onestage-mysql --desired-status RUNNING --query "taskArns[0]" --output text

if (-not $taskArn -or $taskArn -eq "None") {
  Write-Error "No running mysql task found - start it first (scripts/start-env.sh)."
  exit 1
}

$eniId = aws ecs describe-tasks @ProfileArgs --region $Region --cluster $Cluster --tasks $taskArn --query "tasks[0].attachments[?type=='ElasticNetworkInterface'] | [0].details[?name=='networkInterfaceId'].value | [0]" --output text

aws ec2 describe-network-interfaces @ProfileArgs --region $Region --network-interface-ids $eniId --query "NetworkInterfaces[0].Association.PublicIp" --output text
