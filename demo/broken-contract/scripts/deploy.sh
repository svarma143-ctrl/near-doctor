#!/bin/sh
# Deploy the contract to a throwaway testnet account.
set -e
near dev-deploy target/near/tipjar.wasm
