const forge = require('node-forge');

function generateKeyPair() {
  // Generate 2048-bit RSA keypair
  const keys = forge.pki.rsa.generateKeyPair(2048);
  
  const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const publicKeySsh = forge.ssh.publicKeyToOpenSSH(keys.publicKey);
  
  return {
    privateKeyPem,
    publicKeyOpenSSH: publicKeySsh
  };
}

module.exports = {
  generateKeyPair
};
