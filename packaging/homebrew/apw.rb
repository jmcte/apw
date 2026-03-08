class Apw < Formula
  desc "Apple Password CLI and daemon (macOS-first)"
  homepage "https://github.com/omt-global/apw-native"
  version "1.2.0"
  url "https://github.com/omt-global/apw-native/archive/refs/tags/v1.2.0.tar.gz"
  sha256 "<replace-with-release-tarball-sha256>"
  license "GPL-3.0-only"

  depends_on "rust" => :build

  on_macos do
    # macOS keychain path integration requires macOS.
  end

  def install
    system "cargo", "build", "--manifest-path", "rust/Cargo.toml", "--release"
    bin.install "rust/target/release/apw"
  end

  service do
    run [opt_bin/"apw", "start"]
    keep_alive true
    run_type :immediate
  end

  test do
    assert_match "Apple Passwords CLI", shell_output("#{bin}/apw --help")
  end
end
