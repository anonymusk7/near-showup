#!/usr/bin/env bash
# Testnet E2E against a deployed event: 2 faucet guests RSVP, host checks in one, anyone settles.
set -euo pipefail
EV=$1; END_NS=$2; START_NS=${3:-0}
N="network-config testnet"
call(){ near contract call-function as-transaction $EV $2 json-args "$3" prepaid-gas '100.0 Tgas' attached-deposit "$4" sign-as $1 $N sign-with-legacy-keychain send 2>&1 | grep -E "Transaction ID|succeeded|Error|panicked" ; }
T=$(date +%s); G1=guest1-$T.testnet; G2=guest2-$T.testnet
for g in $G1 $G2; do near account create-account sponsor-by-faucet-service $g autogenerate-new-keypair save-to-legacy-keychain $N create >/dev/null 2>&1; done
sleep 3
call $G1 rsvp '{}' '0.1 NEAR'; call $G2 rsvp '{}' '0.1 NEAR'
while [ $(date +%s%N) -lt $START_NS ]; do sleep 5; done
call $EV check_in "{\"guest\":\"$G1\"}" '0 NEAR'
while [ $(date +%s%N) -le $END_NS ]; do sleep 5; done; sleep 3
call $G2 settle '{}' '0 NEAR'
near contract call-function as-read-only $EV get_guests json-args '{}' $N now 2>&1 | tail -15
