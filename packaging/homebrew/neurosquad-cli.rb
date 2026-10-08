# Homebrew formula for nsq, the NeuroSquad CLI — template. scripts/release/channels.mjs fills
# {{NPM_NAME}}, {{VERSION}} and {{SHA256}} (of the npm tarball) and opens the PR to the tap
# glmn-ai/homebrew-neurosquad (Formula/neurosquad-cli.rb). Edits made in the tap by hand are
# overwritten on the next release.
class NeurosquadCli < Formula
  desc "Run several AI coding agents in your terminal and get called when one needs you"
  homepage "https://github.com/glmn-ai/neurosquad-cli"
  url "https://registry.npmjs.org/{{NPM_NAME}}/-/{{NPM_BASENAME}}-{{VERSION}}.tgz"
  sha256 "{{SHA256}}"
  license "MIT"

  livecheck do
    url "https://registry.npmjs.org/{{NPM_NAME}}/latest"
    strategy :json do |json|
      json["version"]
    end
  end

  depends_on "node"

  def install
    # std_npm_args installs with --ignore-scripts: every native addon nsq uses must come from a
    # prebuild (CI's pack smoke checks exactly this install mode on macOS and Linux).
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/nsq --version")
  end
end
