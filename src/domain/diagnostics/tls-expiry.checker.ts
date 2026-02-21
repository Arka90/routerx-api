

import tls from "tls";

export async function getCertificateExpiry(host: string): Promise<Date | null> {
  return new Promise((resolve) => {
    const socket = tls.connect(443, host, { servername: host }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();

      if (cert?.valid_to) {
        resolve(new Date(cert.valid_to));
      } else {
        resolve(null);
      }
    });

    socket.on("error", () => resolve(null));
  });
}
