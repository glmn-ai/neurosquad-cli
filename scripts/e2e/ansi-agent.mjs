// A stand-in agent for the phone page's terminal view: prints a screen with the 16 colours, the
// 256-colour cube, truecolor, bold / dim / italic / underline / inverse / strikethrough, box
// drawing, wide characters (CJK, emoji) and text that would be markup if a page ever used it as
// HTML — then waits, the cursor on a prompt line, until it is stopped.
//
//   node scripts/e2e/ansi-agent.mjs
const E = '\x1b['
const lines = [
  `${E}1;38;5;81mnsq colour check${E}0m`,
  `${E}31mRED${E}0m ${E}32mGREEN${E}0m ${E}33mYELLOW${E}0m ${E}34mBLUE${E}0m ${E}35mMAGENTA${E}0m ${E}36mCYAN${E}0m ${E}91mBRIGHTRED${E}0m ${E}42;30m ON-GREEN ${E}0m`,
  `${E}38;5;208mORANGE256${E}0m ${E}38;5;240mGRAY256${E}0m ${E}38;2;255;105;180mPINKTRUE${E}0m ${E}48;2;20;40;120;97m BLUEBG ${E}0m`,
  `${E}1mBOLD${E}0m ${E}2mDIM${E}0m ${E}3mITALIC${E}0m ${E}4mUNDER${E}0m ${E}7mINVERSE${E}0m ${E}9mSTRIKE${E}0m`,
  '┌──────────┬──────┐',
  '│ 中文 宽字│ 🚀 ok│',
  '└──────────┴──────┘',
  `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script> & "quotes" ${E}31m<b>not bold</b>${E}0m`,
  ''
]
process.stdout.write(lines.join('\r\n'))
process.stdout.write(`${E}32m❯${E}0m type here`)
// The cursor: two cells back into "here".
process.stdout.write(`${E}2D`)
setInterval(() => {}, 60_000)
