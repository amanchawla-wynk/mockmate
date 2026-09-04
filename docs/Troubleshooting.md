# MockMate Troubleshooting Guide

Common issues and solutions for MockMate server and dashboard.

---

## Dashboard Can't Connect to Server

### Symptom
Dashboard shows "Failed to connect to server" error or can't load projects.

### Cause
Server is not running or running on a different port than expected.

### Solution

1. **Check if server is running:**
   ```bash
   lsof -ti:3456  # Should return a process ID
   ```

2. **Check server configuration:**
   ```bash
   cat ~/.mockmate/config.json
   ```

3. **Ensure correct ports:**
   The config should have:
   ```json
   {
     "server": {
       "httpPort": 3456,
       "httpsPort": 3457
     }
   }
   ```

4. **Start the server:**
   ```bash
   cd packages/server
   npm run dev
   ```

5. **Verify server is accessible:**
   ```bash
   curl http://localhost:3456/health
   ```

---

## Port Already in Use

### Symptom
```
Error: listen EADDRINUSE: address already in use :::3456
```

### Solution

1. **Find process using the port:**
   ```bash
   lsof -ti:3456
   ```

2. **Kill the process:**
   ```bash
   kill -9 <PID>
   ```

3. **Or use different ports in config:**
   ```json
   {
     "server": {
       "httpPort": 8080,
       "httpsPort": 8443
     }
   }
   ```

   Then update dashboard proxy in `packages/dashboard/vite.config.ts`:
   ```typescript
   proxy: {
     '/api': {
       target: 'http://localhost:8080',
       changeOrigin: true,
     },
   }
   ```

---

## Certificate Not Trusted on Mobile Device

### Symptom
iOS/Android shows "Certificate not trusted" or SSL error.

### Solution for iOS

1. **Install the certificate:**
   - Download profile from setup page
   - Settings → General → VPN & Device Management
   - Install "MockMate HTTPS Certificate"

2. **Enable full trust (CRITICAL):**
   - Settings → General → About
   - Certificate Trust Settings
   - Enable full trust for "MockMate CA"

### Solution for Android

1. **Install certificate:**
   - Settings → Security → Install from storage
   - Select downloaded certificate
   - Name: "MockMate CA"
   - Usage: "VPN and apps"

2. **Verify installation:**
   - Settings → Security → Trusted credentials
   - User tab → Look for "MockMate CA"

---

## Setup Page Not Loading

### Symptom
`http://localhost:3456/setup` returns 404 or doesn't load.

### Solution

1. **Verify server is running:**
   ```bash
   curl http://localhost:3456/health
   ```

2. **Check setup routes are mounted:**
   - Ensure `setupRouter` is imported in `app.ts`
   - Should see: `app.use('/setup', setupRouter)`

3. **Test directly:**
   ```bash
   curl http://localhost:3456/setup/ca.crt
   ```

---

## QR Code Not Displaying

### Symptom
QR code image broken or not loading on setup page.

### Solution

1. **Check QR code endpoint:**
   ```bash
   curl -I http://localhost:3456/setup/qr
   ```
   Should return `Content-Type: image/png`

2. **Verify qrcode package installed:**
   ```bash
   cd packages/server
   npm list qrcode
   ```

3. **Reinstall if needed:**
   ```bash
   npm install qrcode@^1.5.3
   ```

---

## HTTPS Connection Fails

### Symptom
Can't connect via HTTPS or gets connection refused.

### Solution

1. **Check HTTPS server is running:**
   ```bash
   lsof -ti:3457
   ```

2. **Test with curl:**
   ```bash
   curl -k https://localhost:3457/health
   ```

3. **Verify certificates exist:**
   ```bash
   ls -la ~/.mockmate/certs/
   ```
   Should show: `ca.crt`, `ca.key`, `server.crt`, `server.key`

4. **Regenerate certificates:**
   ```bash
   rm -rf ~/.mockmate/certs/
   # Restart server to regenerate
   ```

---

## Dashboard Build Errors

### Symptom
TypeScript errors when building dashboard.

### Solution

These are known pre-existing issues. The DeviceSetup component itself is valid.

**Workaround:**
Run dashboard in dev mode instead of building:
```bash
cd packages/dashboard
npm run dev
```

---

## Can't Access from Mobile Device

### Symptom
Mobile device can't reach `http://192.168.1.x:3456`.

### Solution

1. **Ensure same WiFi network:**
   - Both computer and device must be on same network

2. **Check firewall:**
   ```bash
   # macOS
   sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate

   # May need to allow Node.js through firewall
   ```

3. **Verify local IP:**
   ```bash
   ifconfig | grep "inet "
   # Use the IP shown on server startup
   ```

4. **Test from computer first:**
   ```bash
   curl http://192.168.1.x:3456/health
   ```

---

## Certificates Expired

### Symptom
Certificate validation fails, shows as expired.

### Solution

1. **Check certificate expiry:**
   ```bash
   openssl x509 -in ~/.mockmate/certs/server.crt -text -noout | grep "Not After"
   ```

2. **Regenerate certificates:**
   ```bash
   rm -rf ~/.mockmate/certs/
   # Restart server
   ```

3. **Reinstall on devices:**
   - Remove old certificate from device
   - Install new one from setup page

---

## Network Interface Changes

### Symptom
IP address changed, certificate doesn't include new IP.

### Solution

1. **Regenerate certificates:**
   ```bash
   rm -rf ~/.mockmate/certs/
   ```

2. **Restart server:**
   - Server will detect new IP and regenerate certificates

3. **Reinstall on devices:**
   - New certificate will include new IP in SANs

---

## Common Configuration Issues

### Wrong Ports

**Problem:** Config has wrong ports
```json
{
  "server": {
    "httpPort": 8080,  // Should be 3456
    "httpsPort": 8443   // Should be 3457
  }
}
```

**Fix:** Update `~/.mockmate/config.json`:
```json
{
  "server": {
    "httpPort": 3456,
    "httpsPort": 3457
  }
}
```

### Missing Config

**Problem:** No config file exists

**Fix:** Create `~/.mockmate/config.json`:
```json
{
  "server": {
    "httpPort": 3456,
    "httpsPort": 3457
  }
}
```

---

## Quick Diagnostics

Run this to check everything:

```bash
# Check if server running
lsof -ti:3456 && echo "✓ HTTP server running" || echo "✗ HTTP server not running"
lsof -ti:3457 && echo "✓ HTTPS server running" || echo "✗ HTTPS server not running"

# Check health
curl -s http://localhost:3456/health && echo "✓ Server healthy" || echo "✗ Server not responding"

# Check certificates
ls ~/.mockmate/certs/*.crt && echo "✓ Certificates exist" || echo "✗ Certificates missing"

# Check setup page
curl -s -o /dev/null -w "%{http_code}" http://localhost:3456/setup && echo " ✓ Setup page accessible" || echo " ✗ Setup page not accessible"
```

---

## Getting Help

1. **Check server logs** - Look at terminal where server is running
2. **Check browser console** - For dashboard errors (F12 → Console)
3. **Verify versions** - Ensure using compatible Node.js version (20+)
4. **Clean reinstall** - Delete `node_modules` and reinstall

---

## Reset Everything

If all else fails, complete reset:

```bash
# Stop all servers
pkill -f "tsx.*index.ts"

# Clear certificates
rm -rf ~/.mockmate/certs/

# Reset config
cat > ~/.mockmate/config.json << 'EOF'
{
  "server": {
    "httpPort": 3456,
    "httpsPort": 3457
  }
}
EOF

# Restart server
cd packages/server
npm run dev
```

---

## Log Locations

- **Server logs**: Terminal output where `npm run dev` was run
- **Config**: `~/.mockmate/config.json`
- **Certificates**: `~/.mockmate/certs/`
- **Projects**: `~/.mockmate/projects/`

---

## Support Commands

```bash
# View config
cat ~/.mockmate/config.json

# View certificate details
openssl x509 -in ~/.mockmate/certs/server.crt -text -noout

# Check what's on ports
lsof -i :3456
lsof -i :3457

# Network interfaces
ifconfig | grep "inet "

# Server health
curl -v http://localhost:3456/health
```
