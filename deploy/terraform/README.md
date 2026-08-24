# Phase 6 ingest — planned Terraform (stub)

This directory is a **pin and a shopping list**, not a working AWS account
module. Inventing `resource "aws_sqs_queue"` blocks that have never been
applied would be vaporware; the interview signal is that the *shape* of the
ingest path is already decided.

## Intended topology

```
SNS (NODD NewNationalBathymetryObject / NewDCDBBathymetryObject)
  → SQS (KMS at rest, redrive to DLQ)
    → ingest worker (container, scale on queue depth)
      → GDAL transform → tile pyramid → object store → manifest
```

A poisoned message exhausts `maxReceiveCount`, lands on the DLQ, and a
CloudWatch alarm on `ApproximateNumberOfMessagesVisible > 0` pages whoever
owns the pipeline.

## Resources that belong here (when a real account exists)

| Resource | Why |
|---|---|
| `aws_sqs_queue` + `aws_sqs_queue` DLQ | Redrive policy, visibility timeout sized to GDAL runtime |
| `aws_kms_key` + alias | Encryption at rest for both queues; no AWS-managed key for CUI-adjacent shops |
| `aws_sns_topic_subscription` | Subscribe the queue to the public NODD topic (or a fan-out topic you own) |
| `aws_iam_role` / policy | Worker: `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes`, `kms:Decrypt` on that key, `s3:GetObject` on the source bucket, `s3:PutObject` on the tile bucket. Nothing else. |
| `aws_cloudwatch_metric_alarm` | DLQ depth ≥ 1 |
| ASG or ECS service | Scale on `ApproximateNumberOfMessagesVisible` |

## What is checked in

- `versions.tf` — pins `hashicorp/aws` `~> 6.0` so a later `terraform init` does not float.
- `variables.tf` — the knobs the real module will take. No dummy `provider "aws"` with a fake account.

Do not run `terraform apply` against this tree; there are no resources.
