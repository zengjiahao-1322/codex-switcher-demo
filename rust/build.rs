use std::{env,fs,path::PathBuf};
use sha2::{Digest,Sha256};
fn main(){
    let root=PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let mut files:Vec<_>=fs::read_dir(root.join("src")).unwrap().map(|entry|entry.unwrap().path()).filter(|path|path.extension().is_some_and(|s|s=="rs"||s=="c")).collect();
    files.push(root.join("build.rs"));
    files.push(root.parent().unwrap().join("package.json"));
    files.push(root.join("Cargo.toml"));files.push(root.join("Cargo.lock"));files.sort();
    let mut hash=Sha256::new();
    for file in files {
        println!("cargo:rerun-if-changed={}",file.display());
        hash.update(file.file_name().unwrap().to_string_lossy().as_bytes());
        hash.update([0]);hash.update(fs::read_to_string(file).unwrap().replace("\r\n","\n").as_bytes());
    }
    println!("cargo:rustc-env=SWITCHER_BUILD_ID={:.12}",format!("{:x}",hash.finalize()));
    if env::var("CARGO_CFG_TARGET_OS").unwrap()=="macos" {
        let out=PathBuf::from(env::var("OUT_DIR").unwrap());
        let source=root.join("src/macos_context.c");
        let object=out.join("macos_context.o");
        assert!(std::process::Command::new("clang").args(["-O2","-mmacosx-version-min=12.0","-c"]).arg(&source).arg("-o").arg(&object).status().unwrap().success());
        assert!(std::process::Command::new("ar").arg("crs").arg(out.join("libswitcher_context.a")).arg(object).status().unwrap().success());
        println!("cargo:rustc-link-search=native={}",out.display());
        println!("cargo:rustc-link-lib=static=switcher_context");
        println!("cargo:rerun-if-changed={}",source.display());
    }
}
