import * as fs from "fs";

import chalk from "chalk";
import { glob } from "glob";

const files = glob.sync("src/{credentials,nodes}/**/*.{png,svg,json}");
files.forEach((file) => {
	const destination = file.replace("src/", "dist/");

	// Ensure the destination directory exists
	const destinationDir = destination.substring(0, destination.lastIndexOf("/"));
	if (!fs.existsSync(destinationDir)) {
		fs.mkdirSync(destinationDir, { recursive: true });
	}

	console.log(`${chalk.green("✔")} ${file} -> ${destination}`);
	fs.copyFileSync(file, destination);
});
