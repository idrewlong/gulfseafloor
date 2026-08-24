variable "aws_region" {
  type        = string
  description = "Region for ingest queues and the worker (planned). NODD topics live in us-east-1."
  default     = "us-east-1"
}

variable "sns_topic_arn" {
  type        = string
  description = "NODD (or fan-out) SNS topic that publishes new-object events."
  default     = ""
}

variable "queue_name" {
  type        = string
  description = "Primary SQS queue name for the ingest worker."
  default     = "gulfseafloor-ingest"
}

variable "dlq_name" {
  type        = string
  description = "Dead-letter queue name. Alarm on visible message count."
  default     = "gulfseafloor-ingest-dlq"
}

variable "max_receive_count" {
  type        = number
  description = "Redrive threshold before a message is considered poisoned."
  default     = 5
}

variable "visibility_timeout_seconds" {
  type        = number
  description = "Must exceed worst-case GDAL + tile write time."
  default     = 300
}

variable "kms_key_arn" {
  type        = string
  description = "CMK for SQS/DLQ at rest. Empty means create one in the real module."
  default     = ""
}

variable "worker_image" {
  type        = string
  description = "Container image for the ingest worker (not the viewer)."
  default     = "ghcr.io/idrewlong/gulfseafloor-ingest:0.1.0"
}

variable "tile_bucket" {
  type        = string
  description = "Destination bucket for the generated Terrarium pyramid."
  default     = ""
}

variable "alarm_sns_topic_arn" {
  type        = string
  description = "Where the DLQ CloudWatch alarm publishes."
  default     = ""
}

variable "asg_min_size" {
  type        = number
  description = "Minimum ingest worker capacity (ASG or ECS desired count)."
  default     = 0
}

variable "asg_max_size" {
  type        = number
  description = "Maximum ingest worker capacity driven by queue depth."
  default     = 4
}
