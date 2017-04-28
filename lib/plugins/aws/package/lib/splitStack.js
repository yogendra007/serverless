'use strict';

const path = require('path');
const _ = require('lodash');
const BbPromise = require('bluebird');
const traverse = require('traverse');
const DepGraph = require('dependency-graph').DepGraph;

module.exports = {
  splitStack() {
    if (!this.serverless.service.provider.useStackSplitting) return BbPromise.resolve();

    this.serverless.service.provider.cloudFormationDependencyGraph = null;
    this.serverless.service.provider.nestedStacks = [];

    return BbPromise.bind(this)
      .then(this.createDependencyGraph)
      .then(this.generateNestedStacks)
      .then(this.writeStacksToDisk)
      .then(this.updateCompiledCloudFormationTemplate);
  },

  createDependencyGraph() {
    const items = this.serverless.service.provider.compiledCloudFormationTemplate;

    const resources = items.Resources;
    const resourcesLogicalIds = Object.keys(resources);
    const outputs = items.Outputs;
    const outputsLogicalIds = Object.keys(outputs);
    const allLogicalIds = _.union(resourcesLogicalIds, outputsLogicalIds);

    const graph = new DepGraph();

    traverse(items).forEach(function (prop) {
      // add all the resources and outputs to the graph
      // note: this.path looks something like this --> ['Resources', 'ResourceLogicalId', ...]
      const type = this.path[0] === 'Resources' ? 'resource' : 'output';
      const name = this.path[1];
      if ((type === 'resource' || type === 'output') && this.path.length === 2) {
        graph.addNode(name, { type });
      }

      // create the dependencies
      // remove the first two items from this.path since they'll be something
      // like ['Resources', 'ResourceLogicalId', ...] to filter out dependencies by key
      const subPath = this.path.slice(2, this.path.length);
      if (subPath.length && _.isString(prop)) {
        if (allLogicalIds.includes(prop)) {
          const dependantName = name;
          const dependencyName = prop;

          graph.addDependency(dependantName, dependencyName);
        }
      }
    });

    this.serverless.service.provider.cloudFormationDependencyGraph = graph;

    return BbPromise.resolve();
  },

  generateNestedStacks() {
    const cfTemplate = this.serverless.service.provider.compiledCloudFormationTemplate;
    const depGraph = this.serverless.service.provider.cloudFormationDependencyGraph;

    const functionResourceLogicalIds = [];

    _.forEach(cfTemplate.Resources, (resource, logicalId) => {
      if (resource.Type === 'AWS::Lambda::Function') {
        functionResourceLogicalIds.push(logicalId);
      }
    });

    _.forEach(functionResourceLogicalIds, (funcLogicalId, index) => {
      const stackObj = {
        stackTemplate: {}, // the complete stack with all it's resources
        stackResource: {}, // the stack resource which will be used in the parent stack
        externalDeps: [], // logical ids of external deps (e.g. in the parent stack)
      };

      const lambdaLogicalIdRegex = this.provider.naming.getLambdaLogicalIdRegex();
      const normalizedFuncNameEnd = lambdaLogicalIdRegex.exec(funcLogicalId).index;
      const normalizedFuncName = funcLogicalId.slice(0, normalizedFuncNameEnd);

      const description = `Stack for function "${funcLogicalId}" and its dependencies`;

      // create the stack template (the template which contains the function and related resources)
      const newStackTemplate = this.cfStackTemplate();
      newStackTemplate.Description = description;
      // add the function
      newStackTemplate.Resources[funcLogicalId] = cfTemplate.Resources[funcLogicalId];
      // add the log group
      const logGroupLogicalIdSuffix = this.provider.naming.getLogGroupLogicalIdSuffix();
      const logGroupLogicalId = `${normalizedFuncName}${logGroupLogicalIdSuffix}`;
      newStackTemplate.Resources[logGroupLogicalId] = cfTemplate.Resources[logGroupLogicalId];
      // add all the other dependant resources and outputs
      const dependantResources = depGraph.dependantsOf(funcLogicalId);
      _.forEach(dependantResources, (dep) => {
        const depLogicalId = dep;
        const depData = depGraph.getNodeData(dep);
        if (depData.type === 'resource') {
          newStackTemplate.Resources[depLogicalId] = cfTemplate.Resources[depLogicalId];
        } else {
          newStackTemplate.Outputs[depLogicalId] = cfTemplate.Outputs[depLogicalId];
        }
      });

      // NOTE: special case here...
      // we copy over the roleLogicalId and modify it to be function specific
      const roleLogicalId = this.provider.naming.getRoleLogicalId();
      const roleResource = _.cloneDeep(cfTemplate.Resources[roleLogicalId]);
      // update the RoleName so that it won't clash
      const roleNameArray = roleResource.Properties.RoleName['Fn::Join'][1];
      const lastPartOfRoleName = roleNameArray.pop();
      const updatedLastPart = `${lastPartOfRoleName}-nested-stack-${index + 1}`;
      roleNameArray[roleNameArray.length - 1] = updatedLastPart;
      // remove all references to other functions
      const funcNameInResourceRegex = new RegExp(`${normalizedFuncName}:*`, 'i');
      const statements = roleResource.Properties.Policies[0].PolicyDocument.Statement;
      statements.forEach((statement) => {
        const updatedStatement = statement;
        const updatedResources = statement.Resource.filter((resource) => {
          const matchingResource = resource['Fn::Sub'].match(funcNameInResourceRegex);
          if (matchingResource) return resource;
          return null;
        });
        const funcResource = updatedResources[0];
        updatedStatement.Resource = [];
        updatedStatement.Resource.push(funcResource);
      });
      roleResource.Properties.Policies[0].PolicyDocument.Statement = statements;

      newStackTemplate.Resources[roleLogicalId] = roleResource;

      // figure out external deps (e.g. resources from the parent stack)
      const dependentResources = depGraph.dependenciesOf(funcLogicalId);
      const nestedStackResources = Object.keys(newStackTemplate.Resources);
      let externalDeps = _.difference(dependentResources, nestedStackResources);
      // remove the roleLogicalId since we already moved it over previously
      externalDeps = externalDeps.filter((dep) => dep !== roleLogicalId);
      stackObj.externalDeps = externalDeps;

      // add external deps as a typed parameter
      _.forEach(externalDeps, (depLogicalId) => {
        newStackTemplate.Parameters[depLogicalId] = {
          // TODO add support for other types
          Type: 'String',
        };
      });

      stackObj.stackTemplate = newStackTemplate;

      // create the (nested) stack resource
      const newStackResource = this.cfStackResourceTemplate();

      const stackId = index + 1;
      const fileName = this.provider.naming.getCompiledNestedStackTemplateFileName(stackId);
      const resourceLogicalId = this.provider.naming.getNestedStackLogicalId(stackId);
      const deploymentBucketName = this.provider.naming.getDeploymentBucketNamePlaceholder();
      const templateURL = `https://s3.amazonaws.com/${
        deploymentBucketName
        }/${
          this.serverless.service.package.artifactDirectoryName
        }/${
          fileName
        }`;

      newStackResource.Description = description;
      newStackResource.Properties.TemplateURL = templateURL;

      // add external deps as ref parameters
      _.forEach(externalDeps, (dep) => {
        const depLogicalId = dep;
        // TODO replace intrinsic functions such as Fn::GetAtt with Ref
        newStackResource.Properties.Parameters[depLogicalId] = {
          Ref: depLogicalId,
        };
      });

      const newStackResourceObj = {
        [resourceLogicalId]: newStackResource,
      };

      stackObj.stackResource = newStackResourceObj;

      this.serverless.service.provider.nestedStacks.push(stackObj);
    });

    return BbPromise.resolve();
  },

  writeStacksToDisk() {
    const nestedStacks = this.serverless.service.provider.nestedStacks;

    _.forEach(nestedStacks, (nestedStack) => {
      const stackResource = nestedStack.stackResource;
      const stackTemplate = nestedStack.stackTemplate;

      const logicalId = Object.keys(stackResource)[0];
      const fileName = stackResource[logicalId].Properties.TemplateURL.split('/').pop();
      const destPath = path.join(
        this.serverless.config.servicePath,
        '.serverless',
        fileName
      );

      this.serverless.utils.writeFileSync(destPath, stackTemplate);
    });

    return BbPromise.resolve();
  },

  updateCompiledCloudFormationTemplate() {
    const cfTemplate = this.serverless.service.provider.compiledCloudFormationTemplate;
    const nestedStacks = this.serverless.service.provider.nestedStacks;

    _.forEach(nestedStacks, (nestedStack) => {
      const stackResource = nestedStack.stackResource;
      const stackTemplate = nestedStack.stackTemplate;

      // remove resources from parent stack since they've been moved to the nested stack
      const resourcesToRemove = stackTemplate.Resources;
      _.forEach(resourcesToRemove, (resource, logicalId) => {
        delete cfTemplate.Resources[logicalId];
      });

      // remove outputs from parent stack since they've been moved to the nested stack
      const outputsToRemove = stackTemplate.Outputs;
      _.forEach(outputsToRemove, (output, logicalId) => {
        delete cfTemplate.Outputs[logicalId];
      });

      // add the stack Resources to parent stack
      _.merge(cfTemplate.Resources, stackResource);
    });

    return BbPromise.resolve();
  },

  // CloudFormation templates
  cfStackTemplate() {
    return {
      AWSTemplateFormatVersion: '2010-09-09',
      Description: 'Stack template',
      Parameters: {},
      Resources: {},
      Outputs: {},
    };
  },

  cfStackResourceTemplate() {
    return {
      Type: 'AWS::CloudFormation::Stack',
      Properties: {
        Parameters: {},
        TemplateURL: '',
      },
    };
  },
};