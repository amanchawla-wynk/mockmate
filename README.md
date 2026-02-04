# MockMate

> Local mock API server for mobile developers with HTTPS support

## ✨ Features

- 🎯 **Scenario-based mocking** - Switch between different API states instantly
- 📱 **Physical device support** - Test on real iOS/Android devices over local network
- 🔒 **HTTPS built-in** - Automatic certificate generation for secure connections
- 🎨 **Web dashboard** - Manage projects, resources, and scenarios visually
- ⚡ **Real-time logging** - See requests as they happen
- 🔄 **Zero code changes** - Switch scenarios without restarting your app

## 🚀 Quick Start

```bash
git clone <this-repo-url>
cd mockmate
npm install
npm start
```

The dashboard will open automatically at http://localhost:3456

## 📖 Usage

### 1. Create a Project
- Open the dashboard
- Click "New Project"
- Give it a name (e.g., "My App")

### 2. Add Resources
- Select your project
- Click "New Resource"
- Define the endpoint (e.g., `GET /api/users`)
- Add response scenarios (default, empty, error, etc.)

### 3. Use in Your App
Point your app to:
- **Simulator**: `http://localhost:3456`
- **Physical Device**: `https://[YOUR_IP]:3457`

### 4. Switch Scenarios
Use the scenario switcher in the dashboard to instantly change API behavior

## 📱 Physical Device Setup

### iOS
1. Connect iPhone/iPad to same WiFi network
2. Open Safari → `http://[YOUR_IP]:3456/setup`
3. Download and install the certificate profile
4. Go to Settings → General → About → Certificate Trust Settings
5. Enable trust for "MockMate CA"
6. Use `https://[YOUR_IP]:3457` in your app

### Android
1. Connect device to same WiFi network
2. Open browser → `http://[YOUR_IP]:3456/setup`
3. Follow the instructions to install the CA certificate
4. Use `https://[YOUR_IP]:3457` in your app

Full guide: [HTTPS Setup Guide](./docs/HTTPS-Support-Guide.md)

## 🛠️ Development

```bash
# Run in development mode (hot reload)
npm run dev:server    # Server only
npm run dev:dashboard # Dashboard only

# Build for production
npm run build

# Run built version
npm start
```

## 📚 Documentation

- [HTTPS Setup Guide](./docs/HTTPS-Support-Guide.md) - Complete guide for device setup
- [Troubleshooting](./docs/Troubleshooting.md) - Common issues and solutions
- [Development Plan](./docs/Development%20Plan.md) - Architecture and implementation details

## 🤝 Contributing

Pull requests welcome! For major changes, please open an issue first.

## 📄 License

MIT

---

**Need help?** Check the [Troubleshooting Guide](./docs/Troubleshooting.md) or open an issue.
