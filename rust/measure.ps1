param([int]$Rounds=10,[int]$IdleSeconds=60,[int]$IdleRounds=1,[ValidateSet('polling','no-page')][string[]]$IdleModes=@('polling'),[switch]$IdleOnly,[switch]$PairedIdle,[string]$ReportPath='',[string]$NativeArchive='',[string]$NodeArchive='',[string]$NativeExecutable='',[string]$NodeExecutable='')
$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
$node=if($NodeExecutable){$NodeExecutable}elseif($IsWindows){Join-Path $project 'runtime/node.exe'}else{(Get-Command node).Source}
$rust=if($NativeExecutable){$NativeExecutable}else{Join-Path $PSScriptRoot ('target/release/codex-switcher'+$(if($IsWindows){'.exe'}else{''}))}
$runRoot=Join-Path ([IO.Path]::GetTempPath()) ('switcher-rust-measure-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runRoot | Out-Null
$rustSource=$rust
$rust=Join-Path $runRoot ('codex-switcher'+$(if($IsWindows){'.exe'}else{''}))
Copy-Item -LiteralPath $rustSource -Destination $rust
function WriteUtf8($path,$text){[IO.File]::WriteAllText($path,$text,[Text.UTF8Encoding]::new($false))}
if($IsWindows){
  $fakeCodex=Join-Path $runRoot 'codex.exe'
  & (Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe') /nologo /target:exe "/out:$fakeCodex" /reference:System.Web.Extensions.dll (Join-Path $project 'tests/fixtures/fake-codex.cs')
  if($LASTEXITCODE -ne 0){throw 'Fake Codex compilation failed'}
}else{
  $fakeCodex=Join-Path $runRoot 'codex'
  WriteUtf8 $fakeCodex @'
#!/bin/sh
if [ -n "$SWITCHER_FAKE_CODEX_VERSION_LOG" ]; then
  printf '%s\n' version >> "$SWITCHER_FAKE_CODEX_VERSION_LOG" || exit 1
fi
printf '%s\n' 'codex-fixture 0.1.0'
'@
  & chmod +x $fakeCodex
  if($LASTEXITCODE -ne 0){throw 'Fake Codex chmod failed'}
}
function Jwt($value){$bytes=[Text.Encoding]::UTF8.GetBytes(($value|ConvertTo-Json -Compress -Depth 8));'fixture.'+[Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')+'.signature'}
function StartFixture($kind,$index){
  $root=Join-Path $runRoot ($kind+'-'+$index);$fixtureHome=Join-Path $root 'home';$bridge=Join-Path $root 'bridge'
  New-Item -ItemType Directory -Path $fixtureHome,$bridge,(Join-Path $bridge 'accounts') -Force | Out-Null
  WriteUtf8 (Join-Path $fixtureHome 'config.toml') 'model="fixture"'
  $auth=@{auth_mode='chatgpt';tokens=@{account_id='fixture-account';access_token=(Jwt @{sub='fixture-user';exp=4102444800;'https://api.openai.com/auth'=@{chatgpt_plan_type='plus'}});id_token=(Jwt @{email='fixture@example.test'});refresh_token='fixture-only'}}
  WriteUtf8 (Join-Path $fixtureHome 'auth.json') ($auth|ConvertTo-Json -Compress -Depth 8)
  $id=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes("fixture-account`0fixture-user"))).ToLower().Substring(0,20)
  WriteUtf8 (Join-Path $bridge 'accounts\index.json') (@(@{id=$id;email='fixture@example.test';label='fixture@example.test';plan='plus'})|ConvertTo-Json -Compress -AsArray)
  $reservation=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$reservation.Start();$port=$reservation.LocalEndpoint.Port;$reservation.Stop()
  $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=if($kind -eq 'node'){$node}else{$rust};$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.WorkingDirectory=$project
  if($kind -eq 'node'){$info.ArgumentList.Add((Join-Path $project 'main.cjs'))};$info.ArgumentList.Add('--no-open')
  $info.Environment['BRIDGE_HOME']=$bridge;$info.Environment['BRIDGE_CODEX_HOME']=$fixtureHome;$info.Environment['CODEX_HOME']=$fixtureHome;$info.Environment['BRIDGE_HERMES_HOME']=(Join-Path $root 'none');$info.Environment['BRIDGE_PORT']=[string]$port;$info.Environment['SWITCHER_WEB_ROOT']=(Join-Path $project 'web');$info.Environment['CODEX_EXE']=$fakeCodex
  foreach($name in @('HOME','USERPROFILE','APPDATA','LOCALAPPDATA')){$directory=Join-Path $root $name;New-Item -ItemType Directory -Path $directory -Force | Out-Null;$info.Environment[$name]=$directory}
  $info.Environment['SWITCHER_TEST_SHELL_ROOT']=(Join-Path $root 'shell');$info.Environment['HTTPS_PROXY']='http://127.0.0.1:9';$info.Environment['SWITCHER_FAKE_CODEX_VERSION_LOG']=(Join-Path $root 'version-calls.log')
  $process=[Diagnostics.Process]::new();$process.StartInfo=$info;$timer=[Diagnostics.Stopwatch]::StartNew();[void]$process.Start()
  $line=$process.StandardOutput.ReadLine();$timer.Stop()
  if($process.HasExited){throw ($kind+' exited '+$process.StandardError.ReadToEnd())}
  $ready=if($kind -eq 'rust'){$line|ConvertFrom-Json}else{Get-Content -Raw (Join-Path $bridge 'running.json')|ConvertFrom-Json}
  $url=[Uri]$ready.url
  [pscustomobject]@{kind=$kind;process=$process;startupMs=$timer.Elapsed.TotalMilliseconds;url=$url.GetLeftPart([UriPartial]::Authority);headers=@{Authorization=('Bearer '+$url.Fragment.Substring(1))};root=$root}
}
function StopFixture($fixture){if(!$fixture.process.HasExited){$fixture.process.Kill();$fixture.process.WaitForExit()};$fixture.process.Dispose()}
function StateFixture($fixture){Invoke-RestMethod -Uri ($fixture.url+'/api/state') -Headers $fixture.headers}
function Snapshot($f){
  $f.process.Refresh()
  [ordered]@{cpuMs=$f.process.TotalProcessorTime.TotalMilliseconds;userCpuMs=$f.process.UserProcessorTime.TotalMilliseconds;kernelCpuMs=$f.process.PrivilegedProcessorTime.TotalMilliseconds;rss=$f.process.WorkingSet64;handles=$(if($IsWindows){$f.process.HandleCount}else{$null});threads=$(if($IsWindows){@($f.process.Threads|ForEach-Object {@{id=$_.Id;cpuMs=$_.TotalProcessorTime.TotalMilliseconds}})}else{@()})}
}
$report=[ordered]@{root=$runRoot;fixture='fake JWT and fake Codex; same files; full Node and full Rust';startedAt=[DateTime]::UtcNow.ToString('o');idleSeconds=$IdleSeconds;idleRounds=$IdleRounds;idleModes=$IdleModes;pairedIdle=[bool]$PairedIdle;cold=@();idle=@();probes=@()}
function SaveReport{
  $json=$report|ConvertTo-Json -Depth 15
  WriteUtf8 (Join-Path $runRoot 'report.json') $json
  if($ReportPath){WriteUtf8 $ReportPath $json}
}
SaveReport
if(!$IdleOnly){foreach($i in 1..$Rounds){foreach($kind in @('node','rust')){$f=StartFixture $kind $i;try{$report.cold+=@{kind=$kind;round=$i;listenMs=$f.startupMs}}finally{StopFixture $f}}}}
$groups=if($PairedIdle){@('paired')}else{@('node','rust')}
foreach($mode in $IdleModes){foreach($round in 1..$IdleRounds){foreach($group in $groups){
  $fixtures=@()
  try{
    $kinds=if($group -eq 'paired'){@('node','rust')}else{@($group)}
    foreach($kind in $kinds){
      $f=StartFixture $kind ('idle-'+$mode+'-'+$round);$fixtures+=,$f
      $state=if($mode -eq 'polling'){StateFixture $f}else{$null}
      $runtime=Invoke-RestMethod -Uri ($f.url+'/api/runtime') -Headers $f.headers
      $html=Invoke-WebRequest -Uri $f.url
      $unauthorized=Invoke-WebRequest -Uri ($f.url+'/api/runtime') -SkipHttpErrorCheck
      $originRejected=Invoke-WebRequest -Uri ($f.url+'/api/runtime') -Headers (@{Origin='https://example.test'}+$f.headers) -SkipHttpErrorCheck
      if($unauthorized.StatusCode -ne 401 -or $originRejected.StatusCode -ne 403 -or $html.StatusCode -ne 200){throw 'Backend auth/static validation failed'}
      $entry=[ordered]@{kind=$kind;mode=$mode;round=$round;pid=$f.process.Id;runtime=$runtime;current=$state.current;httpAuth=401;httpOrigin=403;samples=@();requests=@()}
      $f|Add-Member -NotePropertyName entry -NotePropertyValue $entry
      $report.idle+=,$entry
    }
    Start-Sleep -Seconds 1
    $started=[Diagnostics.Stopwatch]::StartNew()
    foreach($f in $fixtures){$initial=Snapshot $f;$f.entry.initial=$initial;$f.entry.samples+=@{elapsedMs=$started.Elapsed.TotalMilliseconds;snapshot=$initial}}
    SaveReport
    for($target=25;$target -le $IdleSeconds+24;$target+=25){
      $deadline=[Math]::Min($target,$IdleSeconds)*1000
      $remaining=$deadline-$started.Elapsed.TotalMilliseconds
      if($remaining -gt 0){Start-Sleep -Milliseconds ([int]$remaining)}
      foreach($f in $fixtures){
        $before=Snapshot $f
        $f.entry.samples+=@{elapsedMs=$started.Elapsed.TotalMilliseconds;snapshot=$before}
        if($mode -eq 'polling' -and $target -lt $IdleSeconds){
          $requestStarted=$started.Elapsed.TotalMilliseconds;$null=StateFixture $f;$after=Snapshot $f
          $f.entry.requests+=@{elapsedMs=$requestStarted;durationMs=$started.Elapsed.TotalMilliseconds-$requestStarted;cpuMs=$after.cpuMs-$before.cpuMs;userCpuMs=$after.userCpuMs-$before.userCpuMs;kernelCpuMs=$after.kernelCpuMs-$before.kernelCpuMs}
        }
      }
      SaveReport
    }
    foreach($f in $fixtures){
      $last=Snapshot $f
      $f.entry.elapsedMs=$started.Elapsed.TotalMilliseconds;$f.entry.rss=$last.rss;$f.entry.handles=$last.handles;$f.entry.cpuMs=$last.cpuMs-$f.entry.initial.cpuMs;$f.entry.userCpuMs=$last.userCpuMs-$f.entry.initial.userCpuMs;$f.entry.kernelCpuMs=$last.kernelCpuMs-$f.entry.initial.kernelCpuMs
      $versionLog=Join-Path $f.root 'version-calls.log';$f.entry.versionCalls=if(Test-Path -LiteralPath $versionLog){@(Get-Content -LiteralPath $versionLog).Count}else{0}
      $f.entry.finishedAt=[DateTime]::UtcNow.ToString('o')
    }
    SaveReport
  }finally{foreach($f in $fixtures){StopFixture $f}}
}}}
if(!$NativeArchive){$NativeArchive=Join-Path $project 'dist/codex-switcher-windows-x64.zip'}
if(!$NodeArchive){$NodeArchive=Join-Path $project 'collab/downloads-node-136-ranged/codex-switcher-windows-x64.zip'}
$report.sizes=@{rustExe=(Get-Item $rust).Length;rustPublishedZip=(Get-Item $NativeArchive).Length;nodeExe=(Get-Item $node).Length;nodePublishedZip=(Get-Item $NodeArchive).Length}
$report.binarySha256=@{node=(Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLower();rust=(Get-FileHash -LiteralPath $rust -Algorithm SHA256).Hash.ToLower()}
function Median($values){$sorted=@($values|Sort-Object);$middle=[int][Math]::Floor($sorted.Count/2);if($sorted.Count%2){$sorted[$middle]}else{($sorted[$middle-1]+$sorted[$middle])/2}}
$report.medians=@{
  nodeStartupMs=$(if(!$IdleOnly){Median @($report.cold|Where-Object kind -eq 'node'|ForEach-Object {$_.listenMs})}else{$null})
  rustStartupMs=$(if(!$IdleOnly){Median @($report.cold|Where-Object kind -eq 'rust'|ForEach-Object {$_.listenMs})}else{$null})
}
$report.platform=[System.Runtime.InteropServices.RuntimeInformation]::OSDescription
$report.arch=[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
$report.limits=@('Alternating fresh processes for startup; OS file cache is not flushed.','CPU is main process only, excluding child helpers; Windows granularity is typically 15.625ms.','Paired idle runs use distinct TEMP homes and ports, with both backends alive in the same interval.','No-page makes no state request; polling warms state once then requests every 25 seconds before the endpoint.','Codex --version runs only the fake fixture, never an installed Codex.','Local default Node zip is published seq136; CI passes the same-revision Node ZIP. Both processes use current same-revision source.','Native ZIP includes the temporary legacy update bridge, not a Node VM.')
$report.finishedAt=[DateTime]::UtcNow.ToString('o')
SaveReport
Write-Output ($report|ConvertTo-Json -Depth 15)
