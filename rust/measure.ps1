param([int]$Rounds=10,[int]$IdleSeconds=60,[string]$NativeArchive='',[string]$NodeArchive='',[string]$NativeExecutable='',[string]$NodeExecutable='')
$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
$node=if($NodeExecutable){$NodeExecutable}elseif($IsWindows){Join-Path $project 'runtime/node.exe'}else{(Get-Command node).Source}
$rust=if($NativeExecutable){$NativeExecutable}else{Join-Path $PSScriptRoot ('target/release/codex-switcher'+$(if($IsWindows){'.exe'}else{''}))}
$runRoot=Join-Path ([IO.Path]::GetTempPath()) ('switcher-rust-measure-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runRoot | Out-Null
function WriteUtf8($path,$text){[IO.File]::WriteAllText($path,$text,[Text.UTF8Encoding]::new($false))}
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
  $info.Environment['BRIDGE_HOME']=$bridge;$info.Environment['BRIDGE_CODEX_HOME']=$fixtureHome;$info.Environment['CODEX_HOME']=$fixtureHome;$info.Environment['BRIDGE_HERMES_HOME']=(Join-Path $root 'none');$info.Environment['BRIDGE_PORT']=[string]$port;$info.Environment['SWITCHER_WEB_ROOT']=(Join-Path $project 'web');$info.Environment['CODEX_EXE']=''
  $process=[Diagnostics.Process]::new();$process.StartInfo=$info;$timer=[Diagnostics.Stopwatch]::StartNew();[void]$process.Start()
  $line=$process.StandardOutput.ReadLine();$timer.Stop()
  if($process.HasExited){throw ($kind+' exited '+$process.StandardError.ReadToEnd())}
  $ready=if($kind -eq 'rust'){$line|ConvertFrom-Json}else{Get-Content -Raw (Join-Path $bridge 'running.json')|ConvertFrom-Json}
  $url=[Uri]$ready.url
  [pscustomobject]@{kind=$kind;process=$process;startupMs=$timer.Elapsed.TotalMilliseconds;url=$url.GetLeftPart([UriPartial]::Authority);headers=@{Authorization=('Bearer '+$url.Fragment.Substring(1))};root=$root}
}
function StopFixture($fixture){if(!$fixture.process.HasExited){$fixture.process.Kill();$fixture.process.WaitForExit()};$fixture.process.Dispose()}
function StateFixture($fixture){Invoke-RestMethod -Uri ($fixture.url+'/api/state') -Headers $fixture.headers}
$report=[ordered]@{root=$runRoot;fixture='fake JWT only; same files; full Node and full Rust; alternating 10 rounds';cold=@();idle=@();probes=@()}
foreach($i in 1..$Rounds){foreach($kind in @('node','rust')){$f=StartFixture $kind $i;try{$report.cold+=@{kind=$kind;round=$i;listenMs=$f.startupMs}}finally{StopFixture $f}}}
foreach($kind in @('node','rust')){
  $f=StartFixture $kind 'idle';try{
    $state=StateFixture $f
    $runtime=Invoke-RestMethod -Uri ($f.url+'/api/runtime') -Headers $f.headers
    $html=Invoke-WebRequest -Uri $f.url
    $unauthorized=Invoke-WebRequest -Uri ($f.url+'/api/runtime') -SkipHttpErrorCheck
    $originRejected=Invoke-WebRequest -Uri ($f.url+'/api/runtime') -Headers (@{Origin='https://example.test'}+$f.headers) -SkipHttpErrorCheck
    if($unauthorized.StatusCode -ne 401 -or $originRejected.StatusCode -ne 403 -or $html.StatusCode -ne 200){throw 'Backend auth/static validation failed'}
    $f.process.Refresh();$initialCpu=$f.process.TotalProcessorTime.TotalMilliseconds;$started=[Diagnostics.Stopwatch]::StartNew()
    for($elapsed=0;$elapsed -lt $IdleSeconds;$elapsed+=25){$remaining=[Math]::Min(25,$IdleSeconds-$elapsed);Start-Sleep -Seconds $remaining;if($elapsed+25 -lt $IdleSeconds){$null=StateFixture $f}}
    $started.Stop();$f.process.Refresh()
    $report.idle+=@{kind=$kind;runtime=$runtime;elapsedMs=$started.Elapsed.TotalMilliseconds;rss=$f.process.WorkingSet64;cpuMs=$f.process.TotalProcessorTime.TotalMilliseconds-$initialCpu;handles=$(if($IsWindows){$f.process.HandleCount}else{$null});current=$state.current;httpAuth=401;httpOrigin=403}
  }finally{StopFixture $f}
}
if(!$NativeArchive){$NativeArchive=Join-Path $project 'dist/codex-switcher-windows-x64.zip'}
if(!$NodeArchive){$NodeArchive=Join-Path $project 'collab/downloads-node-136-ranged/codex-switcher-windows-x64.zip'}
$report.sizes=@{rustExe=(Get-Item $rust).Length;rustPublishedZip=(Get-Item $NativeArchive).Length;nodeExe=(Get-Item $node).Length;nodePublishedZip=(Get-Item $NodeArchive).Length}
$report.binarySha256=@{node=(Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLower();rust=(Get-FileHash -LiteralPath $rust -Algorithm SHA256).Hash.ToLower()}
function Median($values){$sorted=@($values|Sort-Object);$middle=[int][Math]::Floor($sorted.Count/2);if($sorted.Count%2){$sorted[$middle]}else{($sorted[$middle-1]+$sorted[$middle])/2}}
$report.medians=@{
  nodeStartupMs=(Median @($report.cold|Where-Object kind -eq 'node'|ForEach-Object {$_.listenMs}))
  rustStartupMs=(Median @($report.cold|Where-Object kind -eq 'rust'|ForEach-Object {$_.listenMs}))
}
$report.platform=[System.Runtime.InteropServices.RuntimeInformation]::OSDescription
$report.arch=[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
$report.limits=@('10 alternating fresh processes; OS file cache is not flushed.','CPU=0 reflects process sampling granularity.','Local default Node zip is published seq136; CI passes the same-revision Node ZIP. Both processes use current same-revision source.','Native ZIP includes the temporary legacy update bridge, not a Node VM.')
$report.finishedAt=[DateTime]::UtcNow.ToString('o')
$report|ConvertTo-Json -Depth 12|Set-Content -LiteralPath (Join-Path $runRoot 'report.json') -Encoding utf8
Write-Output ($report|ConvertTo-Json -Depth 12)
