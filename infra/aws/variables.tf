variable "name" {
  type        = string
  default     = "sdlc-dev"
  description = "Prefix for every resource. Also the Secrets Manager prefix."
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "aws_profile" {
  type    = string
  default = "default"
}

variable "bootstrap_admin_email" {
  type        = string
  description = "The person who signs in first and gets the platform admin hat."
}

variable "image_tag" {
  type    = string
  default = "dev"
}

variable "desired_count" {
  type        = number
  default     = 1
  description = "Tasks per service. Use 0 for the first apply, before an image has been pushed."
}

variable "openrouter_key_agents" {
  type        = string
  default     = "not-set"
  sensitive   = true
  description = "The OpenRouter key for agent runs. Without it the gateway starts but model calls fail."
}

variable "monthly_budget_usd" {
  type        = number
  default     = 100
  description = "An AWS Budgets alert for the whole account. 0 turns it off."
}

variable "budget_email" {
  type    = string
  default = ""
}
