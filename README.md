# ForBrokers Plugin Config Console

A standalone administration console for publishing versioned JSON configuration files to remote plugins. It contains only the login page, parameter-row configuration management, public JSON endpoints, plugin feedback status, password change, and version display.

Support: [support@forbrokers.com](mailto:support@forbrokers.com)

Developer: [forbrokers.com](https://forbrokers.com)

## Install on Debian or Ubuntu

```bash
unzip forbrokers-plugin-console-v1.1.1.zip
cd forbrokers-plugin-console-v1.1.1
sudo ./install.sh
```

The interactive installer detects a new installation or upgrade, asks for the domain, port, administrator credentials, and nginx preference, then shows a confirmation summary and installation progress bar. The administrator password requires at least 12 characters and must be entered twice.
After the HTTP installation is healthy, enable HTTPS with your existing reverse proxy or a certificate tool such as `certbot --nginx -d config.example.com` before using production credentials.

For a non-interactive installation:

```bash
sudo ./install.sh \
  --domain config.example.com \
  --admin-user admin \
  --admin-password 'replace-with-a-secure-password' \
  --yes
```

## Upgrade Without Changing Configurations

Extract the newer package and run its installer with the same options:

```bash
sudo ./install.sh
```

Program files are stored in `/opt/forbrokers-plugin-console`. Persistent configurations, users, UUIDs, feedback records, and secrets are stored separately in `/opt/forbrokers-plugin-console-data`. Re-running the installer never replaces the data directory and verifies configuration checksums before and after the upgrade.

After version 1.1.0 is installed, future packages can also be uploaded from **Software Update** in the signed-in console. The console validates the ZIP, creates a program backup, preserves and verifies persistent data, installs dependencies, restarts the service, and reports the result on the same screen.

The root-owned update executor is installed only by `install.sh` and cannot be replaced through a web upload. If a release changes that executor, apply that release once from SSH with `sudo ./install.sh`.

## Change or Reset the Administrator Password

While signed in, select **Change Password** in the top-right corner and enter the current and new passwords. The new password must contain at least 12 characters.

If the password is forgotten, run this command on the server:

```bash
sudo /opt/forbrokers-plugin-console/reset-password.sh --username admin
```

The command asks for the new password without displaying it, creates a timestamped backup of `state.json`, and restarts the service. Existing configurations, active UUIDs, and feedback records remain unchanged.

For non-interactive recovery, `--password` is supported, but the interactive prompt is recommended because command-line passwords can be stored in shell history.

## Service Commands

```bash
sudo systemctl restart forbrokers-plugin-console.service
sudo systemctl status forbrokers-plugin-console.service --no-pager -l
sudo journalctl -u forbrokers-plugin-console.service -n 100 --no-pager
```

The interface is English by default. Administrators can switch to Chinese from the language control in the top-right corner.
