# HTTPS Support Guide

Complete guide for using MockMate with HTTPS for physical device testing.

---

## Overview

MockMate now supports both HTTP and HTTPS servers running simultaneously:

- **HTTP Server** (port 3456): For simulator/emulator testing
- **HTTPS Server** (port 3457): For physical iOS/Android device testing

---

## Quick Start

### 1. Start the Server

```bash
npm run dev
```

You'll see output like:

```
🚀 MockMate Server Started
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📡 HTTP Server:
   http://localhost:3456
   http://192.168.1.34:3456

🔒 HTTPS Server (for physical devices):
   https://localhost:3456
   https://192.168.1.34:3457
```

### 2. Test on Simulator/Emulator

Use the HTTP URL:

```
http://localhost:3456/api/your-endpoint
```

### 3. Test on Physical Device

Use the HTTPS URL with your local IP:

```
https://192.168.1.34:3457/api/your-endpoint
```

**Important**: You must install the CA certificate on your device first (see below).

---

## Certificate Installation

### Why Install a Certificate?

MockMate uses self-signed certificates for HTTPS. Devices need to trust the Certificate Authority (CA) to accept HTTPS connections.

### iOS Certificate Installation

1. **Get CA Certificate**
   - Navigate to: `http://YOUR_LOCAL_IP:3456/setup` (coming in Day 17-18)
   - Or copy from: `~/.mockmate/certs/ca.crt`

2. **Install on iOS Device**
   - AirDrop the `ca.crt` file to your device
   - Tap the file to install
   - Go to Settings → General → VPN & Device Management
   - Install the "MockMate CA" profile

3. **Enable Trust**
   - Go to Settings → General → About → Certificate Trust Settings
   - Enable full trust for "MockMate CA"

### Android Certificate Installation

1. **Get CA Certificate**
   - Copy `~/.mockmate/certs/ca.crt` to your device

2. **Install on Android Device**
   - Go to Settings → Security → Install from storage
   - Select the `ca.crt` file
   - Name it "MockMate CA"
   - Choose "VPN and apps" usage

3. **Configure App (if needed)**
   - Add `network_security_config.xml` to your app
   - Include the certificate in the config

---

## How It Works

### Certificate Generation

On first startup, MockMate automatically:

1. Detects your local network IP addresses
2. Generates a Certificate Authority (CA) certificate
3. Generates a server certificate signed by the CA
4. Includes your local IPs as Subject Alternative Names (SANs)
5. Saves certificates to `~/.mockmate/certs/`

### Certificate Details

**CA Certificate:**
- Name: MockMate CA
- Validity: 10 years
- Purpose: Sign server certificates

**Server Certificate:**
- Name: MockMate Server
- Validity: 1 year
- SANs: localhost, 127.0.0.1, all local IPs
- Signed by: MockMate CA

### Certificate Files

```
~/.mockmate/certs/
├── ca.crt         (CA certificate - install on devices)
├── ca.key         (CA private key - keep secure)
├── server.crt     (Server certificate)
└── server.key     (Server private key - keep secure)
```

---

## Testing HTTPS Connection

### Using curl

```bash
# Test with certificate verification disabled (for testing)
curl -k https://localhost:3457/health

# View certificate details
curl -kvI https://localhost:3457/health
```

### Using Browser

1. Navigate to: `https://localhost:3457`
2. You'll see a security warning (expected for self-signed certs)
3. Click "Advanced" → "Proceed" to continue

### From Mobile App

```swift
// iOS (Swift)
let url = URL(string: "https://192.168.1.34:3457/api/users")!
var request = URLRequest(url: url)
request.addValue("error", forHTTPHeaderField: "X-MockMate-Scenario")
```

```kotlin
// Android (Kotlin)
val url = "https://192.168.1.34:3457/api/users"
val request = Request.Builder()
    .url(url)
    .addHeader("X-MockMate-Scenario", "error")
    .build()
```

---

## Configuration

### Change Ports

Edit `~/.mockmate/config.json`:

```json
{
  "server": {
    "httpPort": 3456,
    "httpsPort": 3457
  }
}
```

### Use Custom Domain

If you have a custom local domain (e.g., via /etc/hosts):

1. Edit `/etc/hosts`:
   ```
   192.168.1.34  mockmate.local
   ```

2. Regenerate certificates:
   ```bash
   rm -rf ~/.mockmate/certs/
   npm run dev
   ```

3. Access via:
   ```
   https://mockmate.local:3457
   ```

---

## Troubleshooting

### "Certificate Not Trusted" Error

**Problem**: Device doesn't trust the certificate

**Solution**:
1. Make sure CA certificate is installed on device
2. Enable full trust in device settings
3. Verify the certificate name is "MockMate CA"

### "Hostname Mismatch" Error

**Problem**: IP address not in certificate SANs

**Solution**:
1. Delete certificates: `rm -rf ~/.mockmate/certs/`
2. Restart server (will regenerate with current IPs)
3. Reinstall CA certificate on device

### "Connection Refused"

**Problem**: Can't connect to server

**Solution**:
1. Check server is running: `curl http://localhost:3456/health`
2. Verify you're on the same network
3. Check firewall isn't blocking ports 3456/3457
4. Verify IP address: `ifconfig` or `ipconfig`

### "Certificate Expired"

**Problem**: Server certificate expired (1 year validity)

**Solution**:
1. Certificates auto-regenerate 30 days before expiry
2. Manually regenerate: `rm -rf ~/.mockmate/certs/ && npm run dev`
3. Reinstall CA certificate on devices

---

## Security Notes

### Is This Secure?

✅ **Yes, for local development:**
- HTTPS encrypts traffic on your local network
- Prevents eavesdropping on API requests
- Required for iOS App Transport Security (ATS)

⚠️ **Not for production:**
- Self-signed certificates aren't trusted by default
- Use proper SSL certificates from a CA in production

### Private Key Security

- Private keys stored with 600 permissions (owner read/write only)
- Never commit `~/.mockmate/certs/` to version control
- Private keys never leave your machine

---

## Advanced Usage

### Multiple Network Interfaces

If you have multiple network interfaces (WiFi, Ethernet, etc.), MockMate includes all IPs in the certificate:

```
Subject Alternative Names:
  DNS:localhost
  IP Address:127.0.0.1
  IP Address:192.168.1.34      (WiFi)
  IP Address:10.0.0.5          (Ethernet)
```

### Certificate Inspection

View certificate details:

```bash
# View CA certificate
openssl x509 -in ~/.mockmate/certs/ca.crt -text -noout

# View server certificate
openssl x509 -in ~/.mockmate/certs/server.crt -text -noout

# Check SANs
openssl x509 -in ~/.mockmate/certs/server.crt -text -noout | grep -A 1 "Subject Alternative Name"
```

---

## API Reference

### startServers(ports?)

Start both HTTP and HTTPS servers.

```typescript
import { startServers } from './app';

const servers = await startServers({
  http: 3456,
  https: 3457
});

// Access servers
servers.httpServer.close();
servers.httpsServer.close();
```

### getLocalIPAddresses()

Get all local IPv4 addresses.

```typescript
import { getLocalIPAddresses } from './services/network';

const ips = getLocalIPAddresses();
// ['192.168.1.34', '10.0.0.5']
```

---

## FAQ

**Q: Do I need HTTPS for simulator testing?**
A: No, use HTTP (port 3456) for simulators/emulators.

**Q: Why do I see a certificate warning in my browser?**
A: This is expected for self-signed certificates. Install the CA certificate to remove the warning.

**Q: Can I use MockMate on multiple devices?**
A: Yes! Install the CA certificate on each device and connect to your local IP.

**Q: What if my IP address changes?**
A: Restart the server. It will regenerate certificates with the new IP.

**Q: Is the CA certificate the same for everyone?**
A: No, each installation generates unique certificates.

**Q: Can I share my CA certificate with my team?**
A: Yes, but regenerate it periodically. Better: have each developer run their own MockMate instance.

---

## Next Steps

- **Day 17-18**: Device setup page with QR codes and download links
- **Phase 3**: Advanced features (import from URL, templates, etc.)

---

## Support

For issues or questions:
- Check [troubleshooting section](#troubleshooting)
- Review server logs for errors
- Verify network connectivity and firewall settings
