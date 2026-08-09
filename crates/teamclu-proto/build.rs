use std::io::Result;

fn main() -> Result<()> {
    let proto_dir = "../../proto";
    let amux = "../../proto/amux.proto";
    let teamclu = "../../proto/teamclu.proto";

    println!("cargo:rerun-if-changed={amux}");
    println!("cargo:rerun-if-changed={teamclu}");

    prost_build::Config::new().compile_protos(&[amux, teamclu], &[proto_dir])?;
    Ok(())
}
