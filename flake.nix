{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }: 
  let 
    mkDevShell = system:
    let
      pkgs = nixpkgs.legacyPackages.${system};
    in
    pkgs.mkShell {
      buildInputs = with pkgs; [
        bun
        cargo
        libiconv
        rustc
        rustfmt
      ];
    };
  in
  {
    devShells.aarch64-darwin.default = mkDevShell "aarch64-darwin";
    devShells.x86_64-darwin.default = mkDevShell "x86_64-darwin";
    devShells.aarch64-linux.default = mkDevShell "aarch64-linux";
    devShells.x86_64-linux.default = mkDevShell "x86_64-linux";
  };
}
