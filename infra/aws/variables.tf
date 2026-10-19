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
  type        = string
  default     = "default"
  description = "Named AWS CLI profile. Empty means use the credentials in the environment (as CI does)."
}

variable "bootstrap_admin_email" {
  type        = string
  description = "The person who signs in first and gets the platform admin hat."
}

variable "independent_review" {
  type        = bool
  default     = true
  description = "Whether the person who started a run may not review it. Turn off only for a stack used by one person."
}

variable "security_review" {
  type        = string
  default     = "on"
  description = "on: a pull request needs a security review before it can be approved. off: it does not."
  validation {
    condition     = contains(["on", "off"], var.security_review)
    error_message = "security_review must be on or off."
  }
}

variable "agent_engine" {
  type        = string
  default     = ""
  description = "claude-code or copilot-cli moves every agent to that engine. Empty leaves each agent on its own."
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
