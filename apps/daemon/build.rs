use std::io::Result;

fn main() -> Result<()> {
    println!("cargo:rerun-if-changed=../../proto/amux.proto");
    println!("cargo:rerun-if-changed=../../proto/teamclaw.proto");
    println!("cargo:rerun-if-env-changed=SUPABASE_URL");
    println!("cargo:rerun-if-env-changed=SUPABASE_ANON_KEY");
    prost_build::compile_protos(
        &["../../proto/amux.proto", "../../proto/teamclaw.proto"],
        &["../../proto/"],
    )?;
    Ok(())
}
