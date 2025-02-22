import * as plugin from "./compiler/plugin.js";
import * as path from "path";
import * as fs from "fs";
import * as ts from "typescript";
import * as type from "./type.js";
import * as descriptor from "./descriptor.js";
import * as rpc from "./rpc.js";
import * as op from "./option";

function createImport(
  identifier: ts.Identifier,
  moduleSpecifier: string,
): ts.ImportDeclaration {
  return ts.factory.createImportDeclaration(
    undefined,
    undefined,
    ts.factory.createImportClause(
      false,
      ts.factory.createNamespaceImport(identifier) as any,
      undefined,
    ),
    ts.factory.createStringLiteral(moduleSpecifier),
  );
}

function replaceExtension(filename: string, extension: string = ".ts"): string {
  return filename.replace(/\.[^/.]+$/, extension);
}


const request = plugin.CodeGeneratorRequest.deserialize(
  new Uint8Array(fs.readFileSync(0)),
);
const response = new plugin.CodeGeneratorResponse({
  supported_features:
    plugin.CodeGeneratorResponse.Feature.FEATURE_PROTO3_OPTIONAL,
  file: [],
});

const options = op.parse(request.parameter);

for (const descriptor of request.proto_file) {
  type.preprocess(descriptor, descriptor.name, `.${descriptor.package ?? ""}`);
}

for (const fileDescriptor of request.proto_file) {
  const name = replaceExtension(fileDescriptor.name);
  const pbIdentifier = ts.factory.createUniqueName("pb");
  const grpcIdentifier = ts.factory.createUniqueName("grpc");

  // Will keep track of import statements
  const importStatements: ts.ImportDeclaration[] = [
    // Create all named imports from dependencies
    ...fileDescriptor.dependency.map((dependency: string) => {
      const identifier = ts.factory.createUniqueName(`dependency`);
      const moduleSpecifier = replaceExtension(dependency, "");
      type.setIdentifierForDependency(dependency, identifier);

      return createImport(
        identifier,
        `./${path.relative(
          path.dirname(fileDescriptor.name),
          moduleSpecifier,
        )}`,
      );
    }),
  ];

  // Create all messages recursively
  let statements: ts.Statement[] = [
    // Process enums
    ...fileDescriptor.enum_type.map((enumDescriptor) =>
      descriptor.createEnum(enumDescriptor),
    ),

    // Process root messages
    ...fileDescriptor.message_type.flatMap((messageDescriptor) =>
      descriptor.processDescriptorRecursively(
        fileDescriptor,
        messageDescriptor,
        pbIdentifier,
      ),
    ),
  ];

  if (statements.length) {
    importStatements.push(createImport(pbIdentifier, "google-protobuf"));
  }

  if (fileDescriptor.service.length) {
    // Import grpc only if there is service statements
    importStatements.push(createImport(grpcIdentifier, options.grpc_package));
    statements.push(...rpc.createGrpcInterfaceType(grpcIdentifier));

    // Create all services and clients
    for (const serviceDescriptor of fileDescriptor.service) {
      statements.push(
        rpc.createUnimplementedServer(
          fileDescriptor,
          serviceDescriptor,
          grpcIdentifier,
        ),
      );

      statements.push(
        rpc.createServiceClient(
          fileDescriptor,
          serviceDescriptor,
          grpcIdentifier,
          options,
        ),
      );
    }
  }

  const { major = 0, minor = 0, patch = 0 } = request.compiler_version;

  const comments = [
    `Generated by the protoc-gen-ts.  DO NOT EDIT!`,
    `compiler version: ${major}.${minor}.${patch}`,
    `source: ${fileDescriptor.name}`,
    `git: https://github.com/thesayyn/protoc-gen-ts`,
  ];

  if (fileDescriptor.options?.deprecated) {
    comments.push("@deprecated");
  }

  const doNotEditComment = ts.factory.createJSDocComment(comments.join("\n")) as ts.Statement;

  // Wrap statements within the namespace
  if (fileDescriptor.package) {
    statements = [
      doNotEditComment,
      ...importStatements,
      descriptor.createNamespace(fileDescriptor.package, statements),
    ];
  } else {
    statements = [doNotEditComment, ...importStatements, ...statements];
  }

  const sourcefile: ts.SourceFile = ts.factory.createSourceFile(
    statements,
    ts.factory.createToken(ts.SyntaxKind.EndOfFileToken),
    ts.NodeFlags.None,
  );
  // @ts-ignore
  sourcefile.identifiers = new Set();

  const content = ts
    .createPrinter({
      newLine: ts.NewLineKind.LineFeed,
      omitTrailingSemicolon: true,
    })
    .printFile(sourcefile);

  response.file.push(
    new plugin.CodeGeneratorResponse.File({
      name,
      content,
    }),
  );

  // after each iteration we need to clear the dependency map to prevent accidental
  // misuse of identifiers
  type.resetDependencyMap();
}

process.stdout.write(response.serialize());
