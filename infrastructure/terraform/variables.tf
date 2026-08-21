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
  type    = list(string)
  default = ["10.0.0.0/24", "10.0.1.0/24"]
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

variable "alert_email" {
  description = "Email address for AWS Budgets alerts."
  type        = string
  default     = "smlaw485@gmail.com"
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

variable "instance_types" {
  description = "Cheapest-viable EC2 instance types for the ECS capacity provider's ASG. Deliberately small so a modest load forces a scale-out event."
  type        = list(string)
  default     = ["t3.micro", "t3.small"]
}

variable "asg_min_size" {
  description = "Minimum EC2 instances in the capacity-provider ASG. 0 lets the whole environment scale to zero when stopped."
  type        = number
  default     = 0
}

variable "asg_max_size" {
  description = "Maximum EC2 instances the capacity provider may scale out to during a load test."
  type        = number
  default     = 4
}

variable "create_services" {
  description = "Gates creation of ECS services (module.services, MySQL). Kept false on the first apply so ECR repos exist before any task definition tries to reference an image in them."
  type        = bool
  default     = false
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
