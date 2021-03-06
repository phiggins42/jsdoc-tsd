import * as dom from "dts-dom";
import { InterfaceDeclaration, ParameterFlags, TypeParameter } from "dts-dom";
import * as fs from "fs";
import * as path from "path";

/* tslint:disable:no-var-requires */
// These modules only exports a function, so require is necessary here
const compare = require("node-version-compare");
const jsdocCommentParser = require("comment-parser");
/* tslint:enable:no-var-requires */

export class JSDocTsdParser {

	private accessFlagMap: { [key: string]: dom.DeclarationFlags } = {
		private: dom.DeclarationFlags.Private,
		protected: dom.DeclarationFlags.Protected,
		public: dom.DeclarationFlags.None,
	};
	private config = {} as any;
	private jsdocItems: TDoclet[] = [];
	private rejectedItems: string[] = [];
	private resultItems: {
		[key: string]: dom.DeclarationBase[];
	};

	constructor(config?: any) {
		this.resultItems = {};
		this.jsdocItems = [];

		if (config) {
			this.config = config;
		}

		if (!this.config.ignoreScopes) {
			this.config.ignoreScopes = [];
		}

		if (typeof this.config.versionComparator !== "function" && (typeof this.config.versionComparator !== "string" || this.config.versionComparator === "")) {
			this.config.versionComparator = (taggedVersion: string, latestVersion: string): boolean => {
				if (taggedVersion.match(/v?([0-9]+\.){2}[0-9]+/i)) {
					if (typeof latestVersion === "string" && latestVersion.match(/v?([0-9]+\.){2}[0-9]+/i)) {
						const result = compare(latestVersion, taggedVersion);
						return result >= 0;
					} else {
						return true;
					}
				} else {
					return true;
				}
			};
		} else if (typeof this.config.versionComparator === "function") {
			// test for errors
			try {
				const result = this.config.versionComparator("", "");
				if (typeof result !== "boolean") {
					throw new Error("The versionComparator-function has to return a boolean, instead got " + typeof result);
				}
			} catch (err) {
				if (err instanceof ReferenceError || err instanceof SyntaxError || err instanceof TypeError) {
					throw new Error("Invalid valueComparator-function: " + err);
				}

				console.log(err);
			}
		} else {
			if (this.config.versionComparator.indexOf("{") > 0) {
				let functionBody = this.config.versionComparator.substr(this.config.versionComparator.indexOf("{") + 1);
				functionBody = functionBody.substr(0, functionBody.length - 1).trim();
				this.config.versionComparator = new Function("param1", "param2", functionBody);
			} else if (fs.existsSync(this.config.versionComparator)) {
				if (path.extname(this.config.versionComparator) !== ".js") {
					throw new Error(this.config.versionComparator + " must be a JavaScript file");
				}
				this.config.versionComparator = require(this.config.versionComparator);
			} else {
				throw new Error("versionComparator must contain a valid path or a valid function as string");
			}

			// test for errors
			try {
				const result = this.config.versionComparator("", "");
				if (typeof result !== "boolean") {
					throw new Error("The versionComparator-function has to return a boolean, instead got " + typeof result);
				}
			} catch (err) {
				if (err instanceof ReferenceError || err instanceof SyntaxError || err instanceof TypeError) {
					throw new Error("Invalid valueComparator-function: " + err);
				}

				console.log(err);
			}
		}
	}

	public getResultItems() {
		return this.resultItems;
	}

	public parse(jsdocItems: TDoclet[]) {
		this.jsdocItems = [];

		jsdocItems.forEach((item) => {
			if (!this.evaluateSinceTag(item.since)) {
				this.rejectedItems.push(item.longname);
			} else if (!item.ignore && this.config.ignoreScopes.indexOf(item.scope) === -1) {
				let addItem = true;
				let addJsDocComment = true;
				let parsedItem: dom.DeclarationBase = {};
				if (!this.resultItems[item.longname]) {
					// only add overloaded items once to jsdocItems
					// because of the two for-loops in prepareResults
					this.jsdocItems.push(item);
					// overloaded items are added to the same key
					// in resultItems
					this.resultItems[item.longname] = [];
				}

				switch (item.kind) {
					case "function":
						parsedItem = this.parseFunction(item as IFunctionDoclet);
						break;

					case "constant":
						parsedItem = this.parseConstant(item as IMemberDoclet);
						break;

					case "member":
						if (item.isEnum) {
							parsedItem = this.parseEnum(item as IMemberDoclet);
						} else {
							parsedItem = this.parseMember(item as IMemberDoclet);
						}
						break;

					case "namespace":
						parsedItem = this.parseNamespace(item as INamespaceDoclet);
						break;

					case "typedef":
						parsedItem = this.parseTypeDefinition(item as ITypedefDoclet);
						break;

					case "file":
						// suppress warnings for this type
						addItem = false;
						break;

					case "class":
						// IClassDoclet with kind 'class'
						if (this.resultItems[item.longname].length === 1) {

							// class is already created, only add the constructor to the class
							parsedItem = this.parseClass(item as IClassDoclet, this.resultItems[item.longname][0] as dom.ClassDeclaration);

							// class is already added
							addItem = false;
						} else {

							// create new class
							parsedItem = this.parseClass(item as IClassDoclet);
						}

						// jsDocComment is already added to the constructors
						// @classdesc is alrady added to the class
						addJsDocComment = false;
						break;

					case "interface":
						// IClassDoclet with kind 'interface'
						parsedItem = this.parseInterface(item as IClassDoclet);
						break;

					case "module":
						parsedItem = this.parseModule(item as INamespaceDoclet);
						break;

					default:
						if ((item as any).kind !== "package") {
							console.warn(`Unsupported jsdoc item kind: ${item.kind} (item name: ${item.longname})`);
						}

						addItem = false;
						break;
				}

				if (addItem) {
					if (addJsDocComment) {
						parsedItem.jsDocComment = this.cleanJSDocComment(item.comment);
					}
					this.handleFlags(item, parsedItem);
					this.handleTags(item, parsedItem);
					this.resultItems[item.longname].push(parsedItem);
				}
			} else {
				// item is ignored because of the @private-annotation or by it's scope
				this.rejectedItems.push(item.longname);
			}
		});
	}

	public prepareResults(): { [key: string]: dom.TopLevelDeclaration } {
		const domTopLevelDeclarations: { [key: string]: dom.TopLevelDeclaration } = {};

		for (const jsdocItem of this.jsdocItems) {
			const parentItem = this.findParentItem(jsdocItem, domTopLevelDeclarations);

			if (parentItem) {
				// add the items we parsed before as a member of the top level declaration
				for (const parsedItem of this.resultItems[jsdocItem.longname]) {
					switch (parentItem.kind) {
						case "namespace":
							const namespaceMember = parsedItem as dom.NamespaceMember;
							switch ((namespaceMember as any).kind) {

								case "const":
									const constDeclaration = dom.create.const((namespaceMember as dom.ConstDeclaration).name, (namespaceMember as dom.ConstDeclaration).type);
									if (parsedItem.flags && ((parsedItem.flags & dom.DeclarationFlags.Export) || (parsedItem.flags & dom.DeclarationFlags.Static))) {
										constDeclaration.flags = dom.DeclarationFlags.Export;
									}
									constDeclaration.comment = namespaceMember.comment;
									constDeclaration.jsDocComment = namespaceMember.jsDocComment;
									(parentItem as dom.NamespaceDeclaration).members.push(constDeclaration);
									break;

								case "property":
									const variableDeclaration = dom.create.variable((namespaceMember as dom.VariableDeclaration).name, (namespaceMember as dom.VariableDeclaration).type);
									if (parsedItem.flags && ((parsedItem.flags & dom.DeclarationFlags.Export) || (parsedItem.flags & dom.DeclarationFlags.Static))) {
										variableDeclaration.flags = dom.DeclarationFlags.Export;
									}
									variableDeclaration.comment = namespaceMember.comment;
									variableDeclaration.jsDocComment = namespaceMember.jsDocComment;
									(parentItem as dom.NamespaceDeclaration).members.push(variableDeclaration);
									break;

								case "function":
									if (!parsedItem.flags || 0 === (parsedItem.flags & dom.DeclarationFlags.Private)) {
										namespaceMember.flags = dom.DeclarationFlags.Export;
									}
									(parentItem as dom.NamespaceDeclaration).members.push(namespaceMember);
									break;

								case "interface":
								case "class":
								case "namespace":
								case "var":
								case "alias":
								case "enum":
									(parentItem as dom.NamespaceDeclaration).members.push(namespaceMember);
									break;

								default:
									console.warn(`Can't add member '${jsdocItem.longname}' to parent item '${(parentItem as any).name}'. Unsupported member type: '${namespaceMember.kind}'`);
									break;
							}
						 break;

						case "class":
							let classMember = parsedItem as dom.ClassMember;

							switch ((classMember as any).kind) {
								case "function":
									const functionDeclaration: dom.FunctionDeclaration = classMember as any;
									classMember = dom.create.method(
										functionDeclaration.name,
										functionDeclaration.parameters,
										functionDeclaration.returnType,
										functionDeclaration.flags,
									);

									classMember.typeParameters = functionDeclaration.typeParameters;
									classMember.comment = functionDeclaration.comment;
									classMember.jsDocComment = functionDeclaration.jsDocComment;
									break;
							}

							(parentItem as dom.ClassDeclaration).members.push(classMember);
							break;

						case "enum":
							// enum members can already exists
							const foundItem = parentItem.members.filter((member) => {
								return member.name === (parsedItem as dom.EnumMemberDeclaration).name;
							}).length > 0;

							if (!foundItem) {
								parentItem.members.push(parsedItem as dom.EnumMemberDeclaration);
							}
							break;

						case "interface":
							let objectTypeMember = parsedItem as dom.ObjectTypeMember;

							switch ((objectTypeMember as any).kind) {
								case "function":
									const functionDeclaration: dom.FunctionDeclaration = objectTypeMember as any;
									objectTypeMember = dom.create.method(
										functionDeclaration.name,
										functionDeclaration.parameters,
										functionDeclaration.returnType,
										functionDeclaration.flags,
									);

									objectTypeMember.typeParameters = functionDeclaration.typeParameters;
									objectTypeMember.comment = functionDeclaration.comment;
									objectTypeMember.jsDocComment = functionDeclaration.jsDocComment;
									break;

								case "property":
									// ok, nothing to change
									break;

								default:
									console.warn(`Can't add member '${jsdocItem.longname}' to parent item '${(parentItem as any).longname}'. Unsupported member type: '${parentItem.kind}'`);
									break;
							}

							(parentItem as dom.InterfaceDeclaration).members.push(objectTypeMember);
							break;

						case "module":
							const moduleMember = parsedItem as dom.ModuleMember;
							switch ((moduleMember as any).kind) {

								case "property":
									const variableDeclaration = dom.create.variable((moduleMember as dom.VariableDeclaration).name, (moduleMember as dom.VariableDeclaration).type);
									if (parsedItem.flags && ((parsedItem.flags & dom.DeclarationFlags.Export) || (parsedItem.flags & dom.DeclarationFlags.Static))) {
										variableDeclaration.flags = dom.DeclarationFlags.Export;
									}
									variableDeclaration.comment = moduleMember.comment;
									variableDeclaration.jsDocComment = moduleMember.jsDocComment;
									(parentItem as dom.ModuleDeclaration).members.push(variableDeclaration);
									break;

								case "function":
								case "alias":
									if (parsedItem.flags && ((parsedItem.flags & dom.DeclarationFlags.Export) || (parsedItem.flags & dom.DeclarationFlags.Static))) {
										moduleMember.flags = dom.DeclarationFlags.Export;
									}
									(parentItem as dom.ModuleDeclaration).members.push(moduleMember);
									break;

								case "interface":
								case "class":
								case "namespace":
								case "const":
								case "var":
									(parentItem as dom.ModuleDeclaration).members.push(moduleMember);
									break;

								default:
									console.warn(`Can't add member '${jsdocItem.longname}' to parent item '${(parentItem as any).longname}'. Unsupported member type: '${moduleMember.kind}'`);
									break;
							}

							break;

						default:
							// parent type not supported
							// tslint:disable-next-line:max-line-length
							console.warn(`Can't add member '${jsdocItem.longname}' to parent item '${(parentItem as any).name}'. Unsupported parent member type: '${parentItem.kind}'.`);
							break;
					}
				}
			} else {
				// parent of the item not found, there are different possible reasons...

				if (jsdocItem.memberof && this.rejectedItems.indexOf(jsdocItem.memberof) >= 0) {
					// parent was rejected by the since comparator
					// so do not add the item
				} else if (jsdocItem.memberof) {
					// item has a parent but the parent was not found, possible reasons:
					// + a typo in the @memberof tag
					// + the parent is a private class that extends a public class
					// do not add the item, but show warning
					console.warn("Missing top level declaration '" + jsdocItem.memberof + "' for member '" + jsdocItem.longname + "'.");
				} else if (!jsdocItem.memberof) {
					// member has no parent, add the item as top-level declaration
					for (const parsedItem of this.resultItems[jsdocItem.longname]) {
						if (!domTopLevelDeclarations[jsdocItem.longname]) {
							domTopLevelDeclarations[jsdocItem.longname] = parsedItem as dom.TopLevelDeclaration;
						}
					}
				}
			}
		}

		return domTopLevelDeclarations;
	}

	public resolveResults(): string {
		let output = "";

		const results = this.prepareResults();
		Object.keys(results).forEach((key) => {
			try {
				output += dom.emit(results[key]);
			} catch (err) {
				console.error(`Unexpected error. Please report this error on github!\nCan't emit item ${key}: ${err}\n\n${JSON.stringify(results[key], null, "\t")}`);
				const jsdocItems = this.jsdocItems.filter((elem) => {
					return (elem.hasOwnProperty("name") && elem.name.endsWith(key)) || (elem.hasOwnProperty("longname") && elem.longname === key);
				});
				console.log(`JSDoc items: \n${JSON.stringify(jsdocItems, null, "\t")}`);
			}
		});

		return output;
	}

	/**
	 * Creates the comment for the jsdoc item
	 * @param comment The complete comment text of the item
	 * @param addExample Indicates if examples should be omitted or not
	 */
	private cleanJSDocComment(comment: string | undefined, addExample = false): string {
		const tagsToPass = new Map([
			["author", true],
			["copyright", true],
			["deprecated", true],
			["example", addExample],
			["returns", true],
			["see", true],
			["throws", true],
			["todo", true],
			["param", true],
			["tutorial", true],
			["variation", true],
			["version", true],
			["license", true],
		]);

		let cleanedComment = "";
		const parsedComments = jsdocCommentParser(comment);
		if (parsedComments.length > 0) { // This should be maximum 1 element (except you pass more than one jsdoc comment, which is here never the case)
			const parsedComment = parsedComments[0];

			// First, add the description
			// The comment parser removes the " * " by line breaks, so we have to add these again
			let itemDescription = "";
			if (parsedComment.description.length > 0) {
				itemDescription = parsedComment.description;
			}

			// Then add all tags as we receive them
			for (const annotation of parsedComment.tags) {
				if (tagsToPass.has(annotation.tag) && tagsToPass.get(annotation.tag)) {
					cleanedComment += "\n@" + annotation.tag;

					const tagValue = (annotation.name + " " + annotation.description).trim();
					if (tagValue.length > 0) {
						// The comment parser removes the " * " by line breaks, so we have to add these again
						// The format everything well, we insert as much spaces as the annotation name + 2, because
						// of the "@" char and a white space
						let spacesToInsert = annotation.tag.length + 2;
						if (annotation.name === "param") {
							spacesToInsert += annotation.name.length;
						}

						cleanedComment += " " + tagValue.replace(/\r?\n/g, "\n" + " ".repeat(spacesToInsert));
					}
				} else if (annotation.tag === "description") {
					itemDescription = annotation.name + " " + annotation.description;
				}
			}

			if (itemDescription.length > 0) {
				cleanedComment = itemDescription.replace(/\r?\n/g, "\n") + cleanedComment;
			}
		}

		return cleanedComment;
	}

	private createDomParams(params: IDocletProp[], functionName?: string): dom.Parameter[] {
		const domParams: dom.Parameter[] = [];
		let typeDef: ITypedefDoclet | undefined;
		let propParam: IDocletProp | undefined;

		for (let i = 0; i < params.length; i++) {
			const param = params[i];
			const paramIsProperty = (param.name.indexOf(".") > 0);
			const nextParamIsProperty = (i + 1 < params.length) && (params[i + 1].name.indexOf(".") > 0);
			const lastParam = (i + 1 === params.length);
			let domParam: dom.Parameter | undefined;

			// check the type of the parameter
			if (!paramIsProperty && nextParamIsProperty) {
				// the parameter is a parameter with properties

				// remember the parameter
				propParam = param;

				// create a new typedef
				typeDef = {
					kind: "typedef",
					longname: functionName + "_" + param.name,
					meta: param.meta,
					name: functionName + "_" + param.name,
					properties: [],
					scope: "",
					type: param.type,
				};
				this.jsdocItems.push(typeDef);

			} else if (paramIsProperty) {
				// the parameter is a property

				if (!typeDef || !typeDef.properties) {
					throw new Error(`Parent of property ${param.name} is missing or incorrect`);
				}

				// add the property to the typedef
				const prop: IDocletProp = {
					comment: param.comment,
					description: param.description,
					name: param.name.substr(param.name.indexOf(".") + 1),
					type: param.type,
				};
				typeDef.properties.push(prop);

				if (lastParam || !nextParamIsProperty) {
					// the parameter is the last property

					if (!propParam) {
						throw new Error(`Parent of property ${param.name} is missing or incorrect`);
					}

					// create an interface from the typedef
					const domInterface: dom.InterfaceDeclaration = this.parseTypeDefinition(typeDef) as dom.InterfaceDeclaration;
					this.resultItems[typeDef.longname] = [domInterface];

					// create the parameter with the interface as type
					let interfaceType;
					const matchArray = typeDef.type.names[0].match(/(?:Array\.<([^>]+)>)|(?:([^\[]*)\[\])/i);
					if (matchArray) {
						interfaceType = dom.create.array(domInterface);
					} else {
						interfaceType = dom.create.typeParameter(typeDef.name, domInterface);
					}

					domParam = dom.create.parameter(propParam.name, interfaceType);
				}

			} else if (param.type && param.type.names.length > 0) {
				// the param has a simple type
				domParam = dom.create.parameter(param.name, this.mapTypesToUnion(param.type.names));

			} else {
				// the param has no type => map to "any"
				domParam = dom.create.parameter(param.name, dom.type.any);
			}

			if (domParam) {
				if (param.optional) {
					domParam.flags = dom.ParameterFlags.Optional;
				}

				this.handleFlags(param, domParam);
				domParams.push(domParam);
			}
		}

		return domParams;
	}

	private evaluateSinceTag(sinceTag: string | undefined) {
		if (typeof sinceTag === "string" && sinceTag !== "") {
			return this.config.versionComparator(sinceTag, this.config.latestVersion);
		} else {
			return true;
		}
	}

	private findParentItem(jsdocItem: TDoclet, domTopLevelDeclarations: { [key: string]: dom.TopLevelDeclaration }): dom.TopLevelDeclaration {
		// we have to find the parent item
		let parentItem: dom.TopLevelDeclaration = null as any;

		if (jsdocItem.memberof) {
			const parentItemNames = jsdocItem.memberof.split(".");
			parentItemNames.forEach((name, index) => {

				if (index < 1) {
					parentItem = domTopLevelDeclarations[name];

					if (!parentItem) {
						if (this.resultItems[name]) {
							domTopLevelDeclarations[name] = this.resultItems[name][0] as dom.TopLevelDeclaration;
							parentItem = domTopLevelDeclarations[name];
						}
					}
				} else if (parentItem) {
					const parentItemAsNamespace = parentItem as dom.NamespaceDeclaration;
					let parentItemName = "";
					for (let i = 0; i < index; i++) {
						if (i > 0) {
							parentItemName += ".";
						}

						parentItemName += parentItemNames[i];
					}

					const itemFound = parentItemAsNamespace.members.some((item) => {
						if (item.name === name) {
							parentItem = item;

							return true;
						} else {
							return false;
						}
					});
				}
			}, this);
		}

		return parentItem;
	}

	private getFunctionReturnValue(jsdocItem: IFunctionDoclet): dom.Type {
		let functionReturnValue: dom.Type;

		if (jsdocItem.returns && jsdocItem.returns.length > 0) {
			if (jsdocItem.returns[0].type) {
				functionReturnValue = this.mapTypesToUnion(jsdocItem.returns[0].type.names);
			} else {
				// the jsdoc comment is incomplete, there is no type information for the return value
				functionReturnValue = dom.type.any;
			}
		} else {
			functionReturnValue = dom.type.void;
		}

		return functionReturnValue;
	}

	private handleFlags(doclet: any, obj: dom.DeclarationBase | dom.Parameter) {
		obj.flags = dom.DeclarationFlags.None;

		obj.flags |= this.accessFlagMap[doclet.access];
		obj.flags |= doclet.optional || doclet.defaultvalue !== undefined ? dom.ParameterFlags.Optional : dom.DeclarationFlags.None;
		obj.flags |= doclet.variable ? dom.ParameterFlags.Rest : dom.DeclarationFlags.None;
		obj.flags |= doclet.virtual ? dom.DeclarationFlags.Abstract : dom.DeclarationFlags.None;
		obj.flags |= doclet.readonly ? dom.DeclarationFlags.ReadOnly : dom.DeclarationFlags.None;
		obj.flags |= doclet.scope === "static" ? dom.DeclarationFlags.Static : dom.DeclarationFlags.None;

		const cast = obj as any;
		if (doclet.optional && cast.kind === "property" && cast.flags === ParameterFlags.Optional) {
			obj.flags = dom.DeclarationFlags.Optional;
		}
	}

	private handleTags(doclet: IDocletBase, obj: any) {
		// check the tags of the class
		if (doclet.tags) {
			for (const tag of doclet.tags) {
				switch (tag.title) {
					case "template":
						if (obj.typeParameters) {
							obj.typeParameters.push(
								dom.create.typeParameter(tag.value),
							);
						}
						break;

					default:
						break;
				}
			}
		}
	}

	private mapTypesToUnion(types: string[]): dom.UnionType {
		const domTypes: dom.Type[] = [];

		types.forEach((type) => {
			domTypes.push(this.mapVariableType(type));
		});

		return dom.create.union(domTypes);
	}

	private mapVariableType(variableType: string) {
		// resolve array types
		// jsdoc will provide arrays always as "Array.<>" if it's typed or as "Array" if it's not typed
		let resultType: dom.Type = dom.type.any;
		while (/^Array/i.test(variableType)) {
			// it's an array, check if it's typed
			const arrayTypeMatches = variableType.match(/Array\.<(\(?[\w|]+\)?)>/i); // @todo: can contain namepaths
			if (arrayTypeMatches && !!arrayTypeMatches[1]) {
				const arrayTypeString: string = arrayTypeMatches[1];
				const arrayType = (arrayTypeString.toLowerCase() === "array") ? dom.type.array(dom.type.any) : this.mapVariableTypeString(arrayTypeString);
				resultType = (resultType === dom.type.any)
					? dom.type.array(arrayType)
					: dom.type.array(resultType); // nested array

				// remove the string from the variable type (nested arrays)
				const regExp = new RegExp(`Array.<${arrayTypeString.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")}>`, "i");
				variableType = variableType.replace(regExp, "");
			} else {
				resultType = dom.type.array(resultType);

				// remove the array keyword
				variableType = variableType.replace(/^Array(\.<)?/i, "");
			}
		}

		if (resultType === dom.type.any) {
			// check if it's an object type (Object.<string, number>)
			const objectTypeMatches = variableType.match(/^Object\.<([^,]+),\s?([^>]+)>$/);
			if (objectTypeMatches && objectTypeMatches.length === 3) {
				resultType = `{ [key: ${objectTypeMatches[1]}]: ${objectTypeMatches[2]} }` as dom.Type;
			} else {
				resultType = this.mapVariableTypeString(variableType);
			}
		}

		return resultType;
	}

	private mapVariableTypeString(variableType: string): dom.Type {
		if (variableType === "bool") {
			variableType = "boolean";
		}

		if (variableType === "function") {
			variableType = "Function";
		}

		if (variableType === "*") {
			variableType = "any";
		}

		// check if it's a union type
		let resultType: dom.Type = variableType as dom.Type;
		if (variableType.indexOf("|") > -1) {
			variableType = variableType.replace(/\(|\)/g, "");
			resultType = this.mapTypesToUnion(variableType.split("|"));
		}

		// check if it's a type parameter
		// e.g. "Promise.<*>" (JSDoc always separate the type with a dot)
		const typeParameterMatches = variableType.match(/^([^<.]+)\.<([^>]+)>$/);
  if (typeParameterMatches && typeParameterMatches.length === 3) {
			// it's not a pretty nice solution, but it works for now
			resultType = dom.create.typeParameter(
				`${typeParameterMatches[1]}<${this.mapVariableType(typeParameterMatches[2]).toString()}>`,
			);
		}

		return resultType;
	}

	private parseClass(jsdocItem: IClassDoclet, domClass?: dom.ClassDeclaration): dom.DeclarationBase {
		if (!domClass) {
			domClass = dom.create.class(jsdocItem.name);
			domClass.jsDocComment = jsdocItem.classdesc;
		}

		// Add the constructor
		let constructorDeclaration: dom.ConstructorDeclaration;
		if (jsdocItem.params && jsdocItem.params.length > 0) {
			constructorDeclaration = dom.create.constructor(this.createDomParams(jsdocItem.params));
		} else {
			// no params
			constructorDeclaration = dom.create.constructor([]);
		}

		constructorDeclaration.jsDocComment = this.cleanJSDocComment(jsdocItem.comment);
		domClass.members.push(constructorDeclaration);

		return domClass;
	}

	private parseConstant(jsdocItem: IMemberDoclet) {
		if (jsdocItem.isEnum) {
			throw new Error(`item ${jsdocItem.longname} is an enum`);
		}

		let propertyType: dom.Type = dom.type.any;
		if (jsdocItem.type && jsdocItem.type.names.length > 0) {
			propertyType = this.mapTypesToUnion(jsdocItem.type.names);
		}

		return dom.create.const(jsdocItem.name, propertyType);
	}

	private parseEnum(jsdocItem: IMemberDoclet): dom.DeclarationBase {
		if (!jsdocItem.isEnum) {
			throw new Error(`item ${jsdocItem.longname} is not an enum`);
		}

		const domEnum: dom.EnumDeclaration = dom.create.enum(jsdocItem.name, (jsdocItem.kind === "constant"));
		if (jsdocItem.properties) {
			for (const property of jsdocItem.properties) {
				const domEnumMember: dom.EnumMemberDeclaration = dom.create.enumValue(property.name, property.defaultvalue);
				domEnumMember.jsDocComment = this.cleanJSDocComment(property.comment);
				domEnum.members.push(domEnumMember);
			}
		}

		return domEnum;
	}

	private parseFunction(jsdocItem: IFunctionDoclet): dom.DeclarationBase {
		const functionReturnValue: dom.Type = this.getFunctionReturnValue(jsdocItem);
		let domFunction: dom.FunctionDeclaration;
		if (jsdocItem.params && jsdocItem.params.length > 0) {
			domFunction = dom.create.function(jsdocItem.name, this.createDomParams(jsdocItem.params, jsdocItem.name), functionReturnValue);
		} else {
			// no params => create a single function declaration
			domFunction = dom.create.function(jsdocItem.name, [], functionReturnValue);
		}

		return domFunction;
	}

	private parseInterface(jsdocItem: IClassDoclet) {
		return dom.create.interface(jsdocItem.name);
	}

	private parseMember(jsdocItem: IMemberDoclet) {
		if (jsdocItem.isEnum) {
			throw new Error(`item ${jsdocItem.longname} is an enum`);
		}

		let propertyType: dom.Type = dom.type.any;
		if (jsdocItem.type && jsdocItem.type.names.length > 0) {
			propertyType = this.mapTypesToUnion(jsdocItem.type.names);
		}

		return dom.create.property(jsdocItem.name, propertyType);
	}

	private parseModule(jsdocItem: INamespaceDoclet) {
		return dom.create.module(jsdocItem.name);
	}

	private parseNamespace(jsdocItem: INamespaceDoclet): dom.DeclarationBase {
		return dom.create.namespace(jsdocItem.name);
	}

	private parseTypeAliasDefinition(jsdocItem: ITypedefDoclet): dom.TypeAliasDeclaration {
		// get the type of our type definition
		let type: dom.Type;
		if (jsdocItem.params) {
			// the type definition is a function type, so we have to create a function type
			// with the dts-dom module
			type = dom.create.functionType(
				this.createDomParams(jsdocItem.params, jsdocItem.name),
				this.getFunctionReturnValue(jsdocItem as any),
			);
		} else {
			type = this.mapVariableType(jsdocItem.type.names[0]);
		}

		return dom.create.alias(
			jsdocItem.name,
			type,
		);
	}

	private parseTypeDefinition(jsdocItem: ITypedefDoclet): dom.DeclarationBase {
		if (jsdocItem.type && jsdocItem.type && jsdocItem.type.names.length > 0 && jsdocItem.type.names[0] === "function") {
			// if the jsdoc item has a property "type", we can be sure that it isn't a typedef
			// which should be mapped to an interface. Instead we create a typeAlias-Declaration
			return this.parseTypeAliasDefinition(jsdocItem);
		} else {
			const domInterface: dom.InterfaceDeclaration = dom.create.interface(jsdocItem.name);

			if (jsdocItem.properties) {
				for (const property of jsdocItem.properties) {
					let propertyType: dom.Type = dom.type.any;
					if (property.type) {
						propertyType = this.mapTypesToUnion(property.type.names);
					}

					const domProperty = dom.create.property(property.name, propertyType);
					domProperty.jsDocComment = property.description;
					this.handleFlags(property, domProperty);

					domInterface.members.push(domProperty);
				}
			}
			return domInterface;
		}
	}

}
