import { expect } from "chai";
import * as dom from "dts-dom";
import * as fs from "fs";
import * as path from "path";
import { parse } from "querystring";
import { JSDocTsdParser } from "../../src/core/jsdoc-tsd-parser";

describe("JSDocTsdParser.parse.module", () => {
	const moduleData: TDoclet[] = JSON.parse(fs.readFileSync(path.resolve(__dirname, "data/module.json"), { encoding: "utf-8" }));
	expect(moduleData.length).to.eq(4);

	it("should parse a module definition", () => {
		const parser = new JSDocTsdParser();
		parser.parse(moduleData);

		const results = parser.getResultItems();
		const moduleDeclarations: dom.ModuleDeclaration[] = results[moduleData[2].longname] as dom.ModuleDeclaration[];

		expect(moduleDeclarations.length).to.eq(1);
		const moduleDeclaration = moduleDeclarations[0];
		expect(moduleDeclaration.jsDocComment).to.eq("my module");
		expect(moduleDeclaration.name).to.eq(moduleData[2].name);
	});

	it("should create a function member of an module", () => {
		const parser = new JSDocTsdParser();
		parser.parse(moduleData);

		const result = parser.prepareResults();
		expect(result).haveOwnPropertyDescriptor("module:myModule");

		const parsedModule: dom.ModuleDeclaration = result["module:myModule"] as dom.ModuleDeclaration;
		expect(parsedModule.members.length).to.eq(2);

		const functionDeclaration: dom.FunctionDeclaration = parsedModule.members[1] as dom.FunctionDeclaration;
		expect(functionDeclaration.jsDocComment).to.eq("my module function\n@param param1 first param\n@param param2 second param\n@returns function return value");
	});

	it("should create a number member of an module", () => {
		const parser = new JSDocTsdParser();
		parser.parse(moduleData);

		const result = parser.prepareResults();
		expect(result).haveOwnPropertyDescriptor("module:myModule");

		const parsedModule: dom.ModuleDeclaration = result["module:myModule"] as dom.ModuleDeclaration;
		expect(parsedModule.members.length).to.eq(2);

		const variableMember: dom.VariableDeclaration = parsedModule.members[0] as dom.VariableDeclaration;
		expect(variableMember.name).to.eq("moduleMember");
		expect(variableMember.jsDocComment).to.eq("my module member");

		const unionType = variableMember.type as dom.UnionType;
		expect(unionType.members.length).to.eq(1);
		expect(unionType.members[0]).to.eq(dom.type.string);
	});
});
