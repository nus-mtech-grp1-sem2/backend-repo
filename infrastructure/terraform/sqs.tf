# Checkout publishes paid orders here; ticket issuance consumes them asynchronously.
resource "aws_sqs_queue" "order_events" {
  name                       = "${local.name_prefix}-order-events"
  message_retention_seconds  = 345600
  visibility_timeout_seconds = 60
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true
}

resource "aws_iam_role" "order_task" {
  name               = "${local.name_prefix}-order-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

data "aws_iam_policy_document" "order_sqs" {
  statement {
    sid       = "PublishOrderPaid"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.order_events.arn]
  }
}

resource "aws_iam_role_policy" "order_sqs" {
  name   = "publish-order-events"
  role   = aws_iam_role.order_task.id
  policy = data.aws_iam_policy_document.order_sqs.json
}

resource "aws_iam_role" "ticket_task" {
  name               = "${local.name_prefix}-ticket-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

data "aws_iam_policy_document" "ticket_sqs" {
  statement {
    sid    = "ConsumeOrderPaid"
    effect = "Allow"
    actions = [
      "sqs:ChangeMessageVisibility",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ReceiveMessage",
    ]
    resources = [aws_sqs_queue.order_events.arn]
  }
}

resource "aws_iam_role_policy" "ticket_sqs" {
  name   = "consume-order-events"
  role   = aws_iam_role.ticket_task.id
  policy = data.aws_iam_policy_document.ticket_sqs.json
}
