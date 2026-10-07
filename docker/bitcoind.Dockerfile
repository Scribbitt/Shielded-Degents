# Bitcoin Core for the dev chain (regtest), from the official release, checksum-verified.
FROM debian:bookworm-slim
ARG BITCOIN_VERSION=29.0
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* \
 && case "$TARGETARCH" in arm64) A=aarch64-linux-gnu ;; amd64) A=x86_64-linux-gnu ;; *) echo "unsupported arch $TARGETARCH"; exit 1 ;; esac \
 && F=bitcoin-${BITCOIN_VERSION}-$A.tar.gz && cd /tmp \
 && curl -fsSLO https://bitcoincore.org/bin/bitcoin-core-${BITCOIN_VERSION}/$F \
 && curl -fsSLO https://bitcoincore.org/bin/bitcoin-core-${BITCOIN_VERSION}/SHA256SUMS \
 && grep " $F\$" SHA256SUMS | sha256sum -c - \
 && tar -xzf $F && install -m 0755 bitcoin-${BITCOIN_VERSION}/bin/bitcoind bitcoin-${BITCOIN_VERSION}/bin/bitcoin-cli /usr/local/bin/ \
 && rm -rf /tmp/*
RUN useradd -m bitcoin
USER bitcoin
EXPOSE 18443
# regtest only: open RPC with fixed dev credentials, large OP_RETURNs allowed (SHORD envelopes)
CMD ["bitcoind", "-regtest", "-server", "-printtoconsole", "-txindex=1", \
     "-rpcbind=0.0.0.0", "-rpcallowip=0.0.0.0/0", "-rpcuser=dev", "-rpcpassword=dev", \
     "-fallbackfee=0.0002", "-datacarriersize=100000", "-acceptnonstdtxn=1"]
