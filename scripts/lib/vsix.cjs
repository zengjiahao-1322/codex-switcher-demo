'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const project = path.resolve(__dirname, '../..');
function build(projectDir = project) {
  const out = path.join(
    process.env.BRIDGE_HOME ||
      (process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'CodexApiSwitcher')
        : path.join(projectDir, 'private')),
    'codex-switcher-companion.vsix',
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const src = path.join(projectDir, 'vscode-companion');
  return require('./zip.cjs').zip(
    ['package.json', 'extension.cjs', 'extension.vsixmanifest', 'content-types.xml'].map(
      (name) => ({
        name:
          name === 'extension.vsixmanifest'
            ? name
            : name === 'content-types.xml'
              ? '[Content_Types].xml'
              : 'extension/' + name,
        file: path.join(src, name),
      }),
    ),
    out,
  );
}
function buildRemote(projectDir = project, dataDir) {
  const source = path.join(projectDir, 'vscode-remote-agent'),
    pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')),
    output = path.join(
      dataDir ||
        process.env.BRIDGE_HOME ||
        (process.platform === 'darwin'
          ? path.join(os.homedir(), 'Library', 'Application Support', 'CodexApiSwitcher')
          : path.join(projectDir, 'private')),
      'codex-switcher-remote.vsix',
    );
  fs.mkdirSync(path.dirname(output), { recursive: true });
  return require('./zip.cjs').zip(
    [
      ...['package.json', 'extension.cjs'].map((name) => ({
        name: 'extension/' + name,
        file: path.join(source, name),
      })),
      {
        name: '[Content_Types].xml',
        file: path.join(projectDir, 'vscode-companion', 'content-types.xml'),
      },
      {
        name: 'extension.vsixmanifest',
        data: `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
 <Metadata><Identity Language="en-US" Id="codex-switcher-remote" Version="${pkg.version}" Publisher="codex-switcher-demo"/><DisplayName>Codex Switcher Remote Agent</DisplayName><Description xml:space="preserve">Apply a selected API to this Remote-SSH server.</Description><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.85.0"/></Properties></Metadata>
 <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
 <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>`,
      },
    ],
    output,
  );
}
module.exports = { build, buildRemote };
