# AWS Backup for the MySQL EFS file system (ADR: containerized MySQL, not
# RDS — see onestage-ai-engineering/docs/adr/0002). Backs up the file system
# directly, so it works regardless of whether the mysql ECS task happens to
# be running — a mysqldump-based approach would need MySQL up at schedule
# time, which conflicts with this project's scale-to-zero-when-idle design.
#
# This is a crash-consistent (not application-consistent) backup: restoring
# is equivalent to MySQL recovering from a power-loss-style restart, which
# InnoDB's redo-log crash recovery handles automatically on next start.
# That's an accepted trade-off for this MVP, not a zero-data-loss guarantee.

resource "aws_backup_vault" "main" {
  name = "${local.name_prefix}-backup-vault"
}

data "aws_iam_policy_document" "backup_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  name               = "${local.name_prefix}-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_trust.json
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_iam_role_policy_attachment" "backup_restore" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"
}

resource "aws_backup_plan" "mysql" {
  name = "${local.name_prefix}-mysql-backup-plan"

  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.main.name
    schedule          = "cron(0 18 * * ? *)" # 18:00 UTC / 02:00 SGT daily

    lifecycle {
      delete_after = 7 # days — cheap, MVP-appropriate retention; raise later if needed
    }
  }
}

resource "aws_backup_selection" "mysql" {
  name         = "${local.name_prefix}-mysql-efs"
  iam_role_arn = aws_iam_role.backup.arn
  plan_id      = aws_backup_plan.mysql.id

  resources = [aws_efs_file_system.mysql.arn]
}
