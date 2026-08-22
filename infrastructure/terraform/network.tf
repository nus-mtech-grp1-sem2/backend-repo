# Single VPC for the whole stack. S3/CloudFront (frontend) are not VPC
# resources at all; only backend compute (ECS, ALB, EFS, MySQL) lives here.
#
# Public subnets only, no NAT. Fargate tasks (unlike EC2-launch-type tasks)
# can get a public IP directly via assign_public_ip, so there's no need for
# a NAT instance/gateway just to let tasks reach ECR/Docker Hub — this also
# sidesteps a DIY-NAT-instance failure mode entirely (see git history:
# nat.tf, removed when this stack moved from ECS-on-EC2 to Fargate).
# Traffic is controlled by security groups (see security_groups.tf), which
# is free. No AWS Network Firewall / WAF (paid, out of budget scope).

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${local.name_prefix}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name_prefix}-igw" }
}

resource "aws_subnet" "public" {
  count                   = length(var.public_subnet_cidrs)
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = true

  tags = { Name = "${local.name_prefix}-public-${var.azs[count.index]}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${local.name_prefix}-public-rt" }
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}
