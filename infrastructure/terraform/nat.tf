# DIY NAT instance (t4g.nano) instead of a managed NAT Gateway — see the
# cost note in network.tf. Standard AWS-documented pattern: IP forwarding +
# iptables MASQUERADE, source/dest check disabled so it can route traffic
# that isn't addressed to itself.

data "aws_ssm_parameter" "al2023_arm64_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_security_group" "nat" {
  name        = "${local.name_prefix}-nat"
  description = "NAT instance: allow all traffic from the VPC private subnets"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "All traffic from within the VPC (private subnets routing through this NAT)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name_prefix}-nat-sg" }
}

resource "aws_instance" "nat" {
  ami                    = data.aws_ssm_parameter.al2023_arm64_ami.value
  instance_type          = var.nat_instance_type
  subnet_id              = aws_subnet.public[0].id
  vpc_security_group_ids = [aws_security_group.nat.id]
  source_dest_check      = false # required for a NAT instance to forward traffic not addressed to itself

  metadata_options {
    http_tokens = "required" # IMDSv2 only
  }

  user_data = <<-EOF
    #!/bin/bash
    set -e
    sysctl -w net.ipv4.ip_forward=1
    echo "net.ipv4.ip_forward = 1" >> /etc/sysctl.conf
    IFACE=$(ip -o -4 route show to default | awk '{print $5}')
    iptables -t nat -A POSTROUTING -o "$IFACE" -j MASQUERADE
    iptables -P FORWARD ACCEPT
  EOF

  tags = { Name = "${local.name_prefix}-nat" }
}

resource "aws_eip" "nat" {
  instance = aws_instance.nat.id
  domain   = "vpc"

  tags = { Name = "${local.name_prefix}-nat-eip" }
}
