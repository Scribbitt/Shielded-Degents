# The Shielded Degents dev stack: launches a collection on the regtest node, then runs the platform
# service (:5030) and the web vault (:8790).
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor/shielded-ordinals/package.json vendor/shielded-ordinals/package-lock.json vendor/shielded-ordinals/
RUN npm ci --no-audit --no-fund && (cd vendor/shielded-ordinals && npm ci --no-audit --no-fund)
COPY . .
# compile the circuits (the proving key itself is the committed dev ceremony in zk/dev-ceremony)
RUN cd vendor/shielded-ordinals && mkdir -p build && npx circom2 circuits/spend.circom --r1cs --wasm -o build
EXPOSE 5030 8790
CMD ["node", "scripts/dev-stack.mjs"]
