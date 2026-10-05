resource "random_password" "mysql_root" {
  length  = 24
  special = false # simplifies shell/env-var handling in the container
}

resource "random_password" "mysql_app" {
  length  = 24
  special = false
}

resource "random_password" "internal_api_token" {
  length  = 32
  special = false
}

resource "random_password" "scanner_session_secret" {
  length  = 64
  special = false
}

# AWS-managed key: re-encrypting with a customer-managed key means giving the ECS
# execution role kms:Decrypt on it, and a mistake there stops every service from
# starting. Revisit with a reviewed key policy if the project outlives the course.
#tfsec:ignore:aws-ssm-secret-use-customer-key
resource "aws_secretsmanager_secret" "mysql" {
  name = "${local.name_prefix}/mysql"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret_version" "mysql" {
  secret_id = aws_secretsmanager_secret.mysql.id
  secret_string = jsonencode({
    MYSQL_ROOT_PASSWORD    = random_password.mysql_root.result
    MYSQL_DATABASE         = "onestage"
    MYSQL_USER             = "onestage_app"
    MYSQL_PASSWORD         = random_password.mysql_app.result
    INTERNAL_API_TOKEN     = random_password.internal_api_token.result
    SCANNER_SESSION_SECRET = random_password.scanner_session_secret.result
  })

  # SMTP_USER and SMTP_APP_PASSWORD (the Gmail sender used by the notification
  # service) are added to this secret by hand in the AWS console so the password
  # never enters Terraform state. Without this, the next apply would write the
  # JSON above back over the secret and erase those two keys. Any key that
  # should change from now on is changed in the console, not in this block.
  lifecycle {
    ignore_changes = [secret_string, version_stages]
  }
}
