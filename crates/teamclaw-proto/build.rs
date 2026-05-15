use std::io::Result;

fn main() -> Result<()> {
    let proto_dir = "../../proto";
    let amux = "../../proto/amux.proto";
    let teamclaw = "../../proto/teamclaw.proto";

    println!("cargo:rerun-if-changed={amux}");
    println!("cargo:rerun-if-changed={teamclaw}");

    prost_build::Config::new().compile_protos(&[amux, teamclaw], &[proto_dir])?;
    Ok(())
}
