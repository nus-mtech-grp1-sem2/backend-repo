variable "account_id" {
  description = "AWS account ID this stack must run in (swe5001-project)."
  type        = string
  default     = "195663985359"
}

variable "region" {
  description = "AWS region for all resources."
  type        = string
  default     = "ap-southeast-1"
}

variable "azs" {
  description = "Availability zones to spread public subnets/ALB across."
  type        = list(string)
  default     = ["ap-southeast-1a", "ap-southeast-1b"]
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "Public subnets: ALB and the NAT instance live here."
  type        = list(string)
  default     = ["10.0.0.0/24", "10.0.1.0/24"]
}

variable "github_org" {
  description = "GitHub org the two repos live under."
  type        = string
  default     = "nus-mtech-grp1-sem2"
}

variable "backend_repo_name" {
  type    = string
  default = "backend-repo"
}

variable "frontend_repo_name" {
  type    = string
  default = "core-frontend"
}

variable "alert_emails" {
  description = "Email addresses AWS Budgets alerts go to (set in terraform.tfvars)."
  type        = list(string)

  validation {
    condition     = length(var.alert_emails) >= 1 && length(var.alert_emails) <= 10
    error_message = "AWS Budgets allows 1 to 10 email subscribers per notification."
  }
}

variable "budget_target_usd" {
  description = "Soft monthly budget target (inclusive of load-test periods)."
  type        = number
  default     = 50
}

variable "budget_ceiling_usd" {
  description = "Hard monthly budget ceiling."
  type        = number
  default     = 100
}

variable "create_services" {
  description = "Gates creation of ECS services (module.services, MySQL). Kept false on the first apply so ECR repos exist before any task definition tries to reference an image in them."
  type        = bool
  default     = false
}

variable "grafana_aws_account_id" {
  description = "AWS account ID Grafana Cloud uses to assume the CloudWatch read-only role -- shown on the CloudWatch data source's 'Grafana Assume Role' setup page. Not a secret (it's just Grafana's own AWS account, common to every customer's data source); the external ID below is what actually scopes access to this stack."
  type        = string
  default     = "008923505280"
}

variable "grafana_external_id" {
  description = "External ID Grafana Cloud generated for this stack's CloudWatch data source (same setup page as grafana_aws_account_id). Not committed here -- set via grafana.auto.tfvars (gitignored, see grafana.auto.tfvars.example) or -var. AWS's own guidance is to not broadcast external IDs even though the actual security boundary is the trusted account ID, not this value's secrecy."
  type        = string
  default     = ""
  sensitive   = true
}

variable "node_services" {
  description = "The 7 backend microservices sharing the onestage-backend image, keyed by name -> container port."
  type        = map(number)
  default = {
    event        = 3001
    inventory    = 3002
    queue        = 3003
    order        = 3004
    ticket       = 3005
    notification = 3006
    auth         = 3007
  }
}
