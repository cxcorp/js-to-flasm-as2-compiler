#!/usr/bin/env node

const { codeFrameColumns } = require("@babel/code-frame");
const util = require("util");
const rimrafAsync = util.promisify(require("rimraf"));
const fs = require("fs");
const path = require("path");
const nodeDir = require("node-dir");

const { Compiler, CompilerError } = require("../lib/compiler");

if (require.main !== module) {
  throw new Error("This module is not for require()ing");
}

// ran as script instead of require()
runAsCommand().catch((e) => {
  console.error(e);
  process.exit(1);
});

async function readConfig() {
  const configFile = process.argv[3] || "./js-to-flasm.config.json";
  try {
    return fs.promises.readFile(configFile, "utf-8");
  } catch (e) {
    if (e.code === "ENOENT") {
      throw new Error(`Config file "${configFile}" does not exist!`);
    }
    throw e;
  }
}

async function getConfig() {
  const data = await readConfig();
  try {
    return JSON.parse(data);
  } catch (e) {
    const err = new Error(`Config file contained malformed JSON!`);
    err.original = e;
    throw err;
  }
}

async function runAsCommand() {
  // assume it's not malformed
  const { dist, sourceRoot } = await getConfig();
  await rimrafAsync(dist);
  await fs.promises.mkdir(dist, { recursive: true });

  return new Promise((resolve, reject) => {
    nodeDir.readFiles(
      sourceRoot,
      { match: /.js$/ },
      async (err, content, file, next) => {
        if (err) throw err;
        if (content.trim().length === 0) {
          console.log(`empty file ${file}`);
          next();
          return;
        }

        const relativeFilePath = path.relative(sourceRoot, file);

        const compiler = new Compiler({
          writeDebug: true,
          emitAssignmentComments: true,
          emitStatementComments: true,
          emitRegisterComments: true,
        });
        try {
          const output = compiler.compile(content);

          const outputDir = path.dirname(path.join(dist, relativeFilePath));
          const fileName = path.basename(
            relativeFilePath,
            path.extname(relativeFilePath)
          );
          const outputFilePath = path.join(outputDir, `${fileName}.flm`);

          await fs.promises.mkdir(outputDir, {
            recursive: true,
          });
          await fs.promises.writeFile(outputFilePath, output, "utf-8");

          console.log(`${file} -> ${outputFilePath}`);
        } catch (e) {
          if (e instanceof CompilerError) {
            console.error(`Compiler error in file "${relativeFilePath}"`);
            e.message += "\n" + codeFrameColumns(content, e.astNode.loc);
            e.message += JSON.stringify(e.astNode, null, 2);
          }

          reject(e);
          return;
        }

        next();
      },
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}
