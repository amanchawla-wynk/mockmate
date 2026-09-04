/**
 * iOS Configuration Profile Generator
 * Creates .mobileconfig files for easy CA certificate installation on iOS devices
 */

import { v4 as uuidv4 } from 'uuid';

/**
 * Generate iOS configuration profile (.mobileconfig) for CA certificate installation
 * @param caCertPem - CA certificate in PEM format
 * @param hostname - Server hostname or IP address
 * @returns XML content for .mobileconfig file
 */
export function generateiOSProfile(caCertPem: string, hostname: string): string {
  // Convert PEM to base64
  const certBase64 = caCertPem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s/g, '');

  const profileUUID = uuidv4();
  const certUUID = uuidv4();

  // iOS Configuration Profile XML format
  const profile = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <array>
        <dict>
            <key>PayloadCertificateFileName</key>
            <string>MockMate-CA.crt</string>
            <key>PayloadContent</key>
            <data>
${certBase64}
            </data>
            <key>PayloadDescription</key>
            <string>MockMate Certificate Authority</string>
            <key>PayloadDisplayName</key>
            <string>MockMate CA</string>
            <key>PayloadIdentifier</key>
            <string>com.mockmate.ca.${certUUID}</string>
            <key>PayloadType</key>
            <string>com.apple.security.root</string>
            <key>PayloadUUID</key>
            <string>${certUUID}</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
        </dict>
    </array>
    <key>PayloadDescription</key>
    <string>Install this profile to trust MockMate's local HTTPS server on ${hostname}</string>
    <key>PayloadDisplayName</key>
    <string>MockMate HTTPS Certificate</string>
    <key>PayloadIdentifier</key>
    <string>com.mockmate.profile.${profileUUID}</string>
    <key>PayloadOrganization</key>
    <string>MockMate</string>
    <key>PayloadRemovalDisallowed</key>
    <false/>
    <key>PayloadType</key>
    <string>Configuration</string>
    <key>PayloadUUID</key>
    <string>${profileUUID}</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
</dict>
</plist>`;

  return profile;
}

/**
 * Generate Android network security config XML
 * @param hostname - Server hostname or IP address
 * @returns XML content for network_security_config.xml
 */
export function generateAndroidNetworkConfig(hostname: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
        </trust-anchors>
    </base-config>
    <domain-config cleartextTrafficPermitted="false">
        <domain includeSubdomains="false">${hostname}</domain>
        <trust-anchors>
            <certificates src="user" />
        </trust-anchors>
    </domain-config>
</network-security-config>`;
}
