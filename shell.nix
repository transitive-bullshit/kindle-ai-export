{ pkgs ? import <nixpkgs> {} }:

with pkgs;

mkShell {
  buildInputs = [
    python3
    python3.pkgs.opencv4
    # python3.pkgs.pillow # PIL
    python3.pkgs.imageio
    python3.pkgs.python-dotenv
    python3.pkgs.scikit-image # skimage
    # fix: montage: unable to read font
    # https://github.com/NixOS/nixpkgs/issues/153884
    (imagemagick.override { ghostscriptSupport = true; })
    ghostscript
  ];
}
