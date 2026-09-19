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
}
