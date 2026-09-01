variable "name" {
  type = string
}

variable "image" {
  type = string
}

variable "port" {
  type = number
}

variable "cpu" {
  type = number
}

variable "memory" {
  type = number
}

variable "min_count" {
  type = number
}

variable "max_count" {
  type = number
}

variable "extra_env" {
  type    = map(string)
  default = {}
}

variable "secret_env" {
  description = "Environment variable names mapped to Secrets Manager JSON keys."
  type        = map(string)
  default     = {}
}

variable "service_connect_alias" {
  type = string
}

variable "attach_to_alb" {
  type    = bool
  default = false
}

variable "health_check_command" {
  type = list(string)
}

variable "scaling_metric" {
  description = "\"cpu\" or \"alb_request_count\""
  type        = string
}

variable "scaling_target" {
  type = number
}

variable "region" {
  type = string
}

variable "cluster_id" {
  type = string
}

variable "cluster_name" {
  type = string
}

variable "namespace_arn" {
  type = string
}

variable "execution_role_arn" {
  type = string
}

variable "task_role_arn" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "security_group_ids" {
  type = list(string)
}

variable "log_retention_days" {
  type    = number
  default = 7
}

variable "alb_target_group_arn" {
  type    = string
  default = null
}

variable "alb_listener_arn" {
  description = "Used only to order service creation after the listener exists"
  type        = string
  default     = null
}

variable "alb_resource_label" {
  description = "arn_suffix/arn_suffix string for ALBRequestCountPerTarget, required when attach_to_alb is true"
  type        = string
  default     = null
}

variable "name_prefix" {
  type = string
}
