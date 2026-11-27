"""Inspect/apply only the requested private TCP 5678 security-list rule.

Uses the owner's existing OCI SDK profile; never prints authentication material.
Requires the official oci SDK. No compute-instance or app-server mutation.
"""
import argparse
import ipaddress
import json
import logging
from pathlib import Path
import sys
import oci

SUBNET = 'ocid1.subnet.oc1.ap-hyderabad-1.aaaaaaaacumm5xx66pnuo3oe3xtqdh2nqjn6mmk3ejc4q7rxx3ng2hebipva'
VCN = 'ocid1.vcn.oc1.ap-hyderabad-1.amaaaaaapfemf4aadpgzmh4maclzxco5zd5lvg6ocefbpikracsgwlnsi4ya'
SECURITY_LIST = 'ocid1.securitylist.oc1.ap-hyderabad-1.aaaaaaaailykyc6q5azmvqxvdqjclqvqnkg5e7z322gbqg2rzi7an4ygs6nq'
parser = argparse.ArgumentParser()
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
logging.getLogger('oci').setLevel(logging.CRITICAL)

def permits_port(rule):
    if rule.protocol == 'all':
        return True
    if rule.protocol != '6':
        return False
    port = rule.tcp_options.destination_port_range if rule.tcp_options else None
    return port is None or port.min <= 5678 <= port.max

def exact_rule(rule):
    port = rule.tcp_options.destination_port_range if rule.tcp_options else None
    return (rule.protocol == '6' and rule.source_type == 'CIDR_BLOCK' and
            rule.source == '10.0.0.0/16' and rule.is_stateless is False and
            port is not None and port.min == port.max == 5678 and
            rule.tcp_options.source_port_range is None)

try:
    config = oci.config.from_file()
    if config.get('region') != 'ap-hyderabad-1':
        raise RuntimeError('Unexpected OCI region')
    client = oci.core.VirtualNetworkClient(config, timeout=(10, 30))
    subnet = client.get_subnet(SUBNET).data
    if subnet.vcn_id != VCN or subnet.cidr_block != '10.0.0.0/24' or SECURITY_LIST not in subnet.security_list_ids:
        raise RuntimeError('Expected subnet/security-list association changed')
    responses = {identifier: client.get_security_list(identifier) for identifier in subnet.security_list_ids}
    for response in responses.values():
        for rule in response.data.ingress_security_rules:
            if permits_port(rule):
                if rule.source_type != 'CIDR_BLOCK' or not ipaddress.ip_network(rule.source).subnet_of(ipaddress.ip_network('10.0.0.0/16')):
                    raise RuntimeError('A broader existing TCP 5678 rule requires review')
    response = responses[SECURITY_LIST]
    before = response.data
    present = any(exact_rule(rule) for rule in before.ingress_security_rules)
    print('Verified subnet: ' + subnet.display_name)
    print('Target security list: ' + before.display_name)
    print('Exact stateful TCP 5678 rule from 10.0.0.0/16 present: ' + str(present))
    if args.apply and not present:
        backup = Path(__file__).resolve().parent.parent / 'data' / 'oracle-security-before.json'
        backup.parent.mkdir(parents=True, exist_ok=True)
        backup.write_text(json.dumps(oci.util.to_dict(before), indent=2))
        rule = oci.core.models.IngressSecurityRule(
            protocol='6', source='10.0.0.0/16', source_type='CIDR_BLOCK', is_stateless=False,
            tcp_options=oci.core.models.TcpOptions(destination_port_range=oci.core.models.PortRange(min=5678, max=5678)),
            description='Field Desk private Steam OTP webhook')
        client.update_security_list(SECURITY_LIST,
            oci.core.models.UpdateSecurityListDetails(ingress_security_rules=[*before.ingress_security_rules, rule]),
            if_match=response.headers['etag'], retry_strategy=oci.retry.NoneRetryStrategy())
        after = client.get_security_list(SECURITY_LIST).data
        if oci.util.to_dict(after.egress_security_rules) != oci.util.to_dict(before.egress_security_rules):
            raise RuntimeError('Concurrent egress change detected')
        prior_rules = [oci.util.to_dict(item) for item in before.ingress_security_rules]
        actual_rules = [oci.util.to_dict(item) for item in after.ingress_security_rules]
        if len(actual_rules) != len(prior_rules) + 1 or not all(item in actual_rules for item in prior_rules) or not any(exact_rule(item) for item in after.ingress_security_rules):
            raise RuntimeError('Unexpected ingress verification result')
        print('Applied and verified the single private TCP 5678 rule. Existing rules preserved.')
    elif args.apply:
        print('Rule already correct; no Oracle mutation needed.')
except oci.exceptions.ServiceError as error:
    print(f'Oracle request failed: HTTP {error.status}, {error.code}. No credentials printed.', file=sys.stderr)
    raise SystemExit(1)
except Exception as error:
    print('Oracle operation stopped: ' + type(error).__name__ + '. No credentials printed.', file=sys.stderr)
    raise SystemExit(1)
