# Name tags only, via aws_ec2_tag — not full adoption (aws_default_network_acl
# etc.), so Terraform never tries to manage these resources' actual rules/
# lifecycle, just labels them for readability in the console/Resource
# Explorer. AWS creates all of these automatically alongside any VPC.

resource "aws_ec2_tag" "default_nacl" {
  resource_id = aws_vpc.main.default_network_acl_id
  key         = "Name"
  value       = "${local.name_prefix}-default-nacl" # actively governs all our subnets — we never created a custom NACL
}

resource "aws_ec2_tag" "default_route_table" {
  resource_id = aws_vpc.main.default_route_table_id
  key         = "Name"
  value       = "${local.name_prefix}-default-rt-unused" # VPC's original main RT; our subnets are explicitly associated with aws_route_table.public instead
}

resource "aws_ec2_tag" "default_security_group" {
  resource_id = aws_vpc.main.default_security_group_id
  key         = "Name"
  value       = "${local.name_prefix}-default-sg-unused" # nothing references this; we use security_groups.tf's purpose-built SGs instead
}

resource "aws_ec2_tag" "dhcp_options" {
  resource_id = aws_vpc.main.dhcp_options_id
  key         = "Name"
  value       = "account-default-dhcp-options-shared" # AWS's account/region-wide default — also used by the account's own default VPC, not onestage-specific
}
