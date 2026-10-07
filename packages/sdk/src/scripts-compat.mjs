// The vendor's gate / lock scripts, re-exported from one place. The vendor module pulls in its own
// copy of bitcoinjs-lib; scripts are plain Buffers, so mixing copies is safe.
export { gateScript, lockScript, lockLeaf, lockPayment, gatePayment, NUMS_X } from '../../../vendor/shielded-ordinals/src/v1/scripts.mjs';
export { LOCK_ESCAPE_CSV as LOCK_ESCAPE_CSV_EXPORT } from '../../../vendor/shielded-ordinals/src/v1/rules.mjs';
