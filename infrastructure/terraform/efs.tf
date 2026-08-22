# MySQL persistence. EFS rather than host EBS — with an ASG (or Managed
# Instances) you don't control which specific host a task lands on the way
# you would with a single pinned instance, so a host-local volume isn't
# reliable across restarts/scale events even though MySQL itself never scales.
resource "aws_efs_file_system" "mysql" {
  encrypted       = true
  throughput_mode = "bursting" # cheapest option, fine for a single small MySQL instance

  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }

  tags = { Name = "${local.name_prefix}-mysql-data" }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_efs_mount_target" "mysql" {
  count           = length(aws_subnet.private)
  file_system_id  = aws_efs_file_system.mysql.id
  subnet_id       = aws_subnet.private[count.index].id
  security_groups = [aws_security_group.efs.id]
}

resource "aws_efs_access_point" "mysql" {
  file_system_id = aws_efs_file_system.mysql.id

  posix_user {
    uid = 999 # matches the `mysql` user/group in the official mysql:8.0 image
    gid = 999
  }

  root_directory {
    path = "/mysql-data"
    creation_info {
      owner_uid   = 999
      owner_gid   = 999
      permissions = "755"
    }
  }
}
