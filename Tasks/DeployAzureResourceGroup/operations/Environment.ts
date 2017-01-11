/// <reference path="../../../definitions/Q.d.ts" />
import networkManagementClient = require("./azure-rest/azure-arm-network");
import computeManagementClient = require("./azure-rest/azure-arm-compute");

import q = require("q");
import util = require("util");
import tl = require("vsts-task-lib/task");
import deployAzureRG = require("../models/DeployAzureRG");
import azureUtil = require("./AzureUtil");

class PropertyValue {
    public IsSecure: boolean;
    public Data: string;

    constructor(data: string, isSecure?: boolean) {
        this.Data = data;
        this.IsSecure = !!isSecure;
    }
}

class Resource {
    public Id: number;
    public Name: string;
    public Properties: { [property: string]: PropertyValue };

    constructor(id: number, name: string) {
        this.Id = id;
        this.Name = name;
        this.Properties = {};
    }

    public addOrUpdateProperty(type: string, property: PropertyValue) {
        this.Properties[type] = property;
    }
}

class Project {
    public Id: string;
    public Name: string;

    constructor(id: string, name: string) {
        this.Id = id;
        this.Name = name;
    }
}

class User {
    public Name: string;

    constructor(name: string) {
        this.Name = name;
    }
}

class Environment {
    public Id: number;
    public Url: string;
    public Revision: number;
    public Project: Project;
    public ModifiedBy: User;
    public Resources: Array<Resource>;
    public Properties: { [property: string]: PropertyValue };
    public Name: string;
    public IsReserved: boolean;
    public CreatedBy: User;
    public CreatedDate: string;
    public ModifiedDate: string;

    constructor(resources: Array<Resource>, userId: string, projectName: string, environmentName: string) {
        this.Id = 0;
        this.Url = null;
        this.Revision = 1;
        this.Project = new Project(projectName, projectName);
        var user = new User(userId);
        this.ModifiedBy = user;
        this.Resources = resources;
        this.Properties = {
            "Microsoft-Vslabs-MG-WinRMProtocol": new PropertyValue("HTTPS"),
            "Microsoft-Vslabs-MG-SkipCACheck": new PropertyValue("False")
        };
        this.Name = environmentName;
        this.IsReserved = false;
        this.CreatedBy = user;
        var timestamp = new Date();
        this.CreatedDate = this.formatDate(timestamp);
        this.ModifiedDate = "0001-01-01T00:00:00";
    }

    private pad(num): string {
        return ("0" + num).slice(-2);
    }

    private formatDate(d): string {
        return [d.getUTCFullYear(),
        this.pad(d.getUTCMonth() + 1),
        this.pad(d.getUTCDate())].join("-") + "T" +
            [this.pad(d.getUTCHours()),
            this.pad(d.getUTCMinutes()),
            this.pad(d.getUTCSeconds())].join(":") + "Z";
    }
}

export class RegisterEnvironment {

    private taskParameters: deployAzureRG.AzureRGTaskParameters;
    private publicAddressToNicIdMap;
    private publicAddressToFqdnMap;
    private nicIdToTagsMap;
    private inboundNatRuleMap;
    private nicIds;
    private loadBalancerToPortMap;
    private loadBalancerToPublicIPAddressMap;

    constructor(taskParameters: deployAzureRG.AzureRGTaskParameters) {
        this.taskParameters = taskParameters;
        this.publicAddressToNicIdMap = null;
        this.nicIdToTagsMap = null;
        this.publicAddressToFqdnMap = null;
        this.loadBalancerToPortMap = null;
        this.nicIds = null;
        this.loadBalancerToPublicIPAddressMap = null;
        this.inboundNatRuleMap = null;
    }

    public RegisterEnvironment(): q.Promise<string> {
        var defered = q.defer<string>();
        if (!this.taskParameters.outputVariable || !this.taskParameters.outputVariable.trim()) {
            tl.setResult(tl.TaskResult.Failed, tl.loc("OutputVariableShouldNotBeEmpty"));
            process.exit();
            return;
        }
        console.log(tl.loc("RegisteringEnvironmentVariable"));
        var details = new azureUtil.AzureUtil(this.taskParameters);
        details.getDetails().then(() => {
            this.parseVMDetails(details.vmDetails);
            this.parseNetworkInterfaceDetails(details.networkInterfaceDetails);
            this.parseLoadBalancerDetails(details.loadBalancersDetails);
            this.parsePublicIPDetails(details.publicAddressDetails);
            this.InstantiateEnvironment();
            defered.resolve("Completed");
        }).catch((error) => {
            tl.setResult(tl.TaskResult.Failed, error);
            process.exit();
        })
        return defered.promise;
    }

    private parseLoadBalancerDetails(loadbalancers): void {
        var inboundNatRuleMap = {};
        for (var i = 0; i < loadbalancers.length; i++) {
            var lb = loadbalancers[i];
            var publicAddress = lb.properties["frontendIPConfigurations"][0].properties["publicIPAddress"]["id"];
            for (var j = 0; j < lb.properties["inboundNatRules"].length; j++) {
                var natRule = lb.properties["inboundNatRules"][j];
                inboundNatRuleMap[natRule["id"]] = {
                    frontendPort: natRule.properties["frontendPort"],
                    backendPort: natRule.properties["backendPort"],
                    publicAddress: publicAddress
                };
            }
        }
        this.inboundNatRuleMap = inboundNatRuleMap;
    }

    private InstantiateEnvironment(): void {
        var resources = this.getResources();
        tl.debug("Got resources..");
        var environment = new Environment(resources, process.env["SYSTEM_COLLECTIONID"], process.env["SYSTEM_TEAMPROJECT"], this.taskParameters.outputVariable);
        tl.setVariable(this.taskParameters.outputVariable, JSON.stringify(environment));
        console.log(tl.loc("AddedToOutputVariable", this.taskParameters.outputVariable));
    }

    private getTags(nicId: string): Array<string> {
        return this.nicIdToTagsMap[nicId];
    }

    private getPort(nicId: string): string {
        var interfaceDetails = this.publicAddressToNicIdMap[nicId];
        var port = "5986";
        if (interfaceDetails.inboundNatRule) {
            var natRules = interfaceDetails.inboundNatRule;
            try {
                for (var i = 0; i < natRules.length; i++) {
                    var natRule = natRules[i];
                    if (this.inboundNatRuleMap[natRule.id].backendPort == 5986) {
                        port = this.inboundNatRuleMap[natRule.id].frontendPort
                    }
                }
            } catch (error) {
                throw new Error(tl.loc("ErrorFetchingNatRules"));
            }
        }
        return port.toString();
    }

    private getFQDN(nicId: string): string {
        var interfaceDetails = this.publicAddressToNicIdMap[nicId];
        try {
            if (interfaceDetails.publicAddress) {
                return this.publicAddressToFqdnMap[interfaceDetails.publicAddress];
            } else {
                var natRule = interfaceDetails.inboundNatRule[0].id;
                var publicAddress = this.inboundNatRuleMap[natRule].publicAddress;
                return this.publicAddressToFqdnMap[publicAddress];
            }
        } catch (error) {
            throw new Error(tl.loc("UnableToFetchFQDN"));
        }
    }

    private getResources(): Array<Resource> {
        var resources = new Array<Resource>();
        var id = 1;
        for (var i = 0; i < this.nicIds.length; i++) {
            var nicId = this.nicIds[i];
            var fqdn = this.getFQDN(nicId);
            var resource = new Resource(id++, fqdn);
            resource.addOrUpdateProperty("Microsoft-Vslabs-MG-Resource-FQDN", new PropertyValue(fqdn));
            resource.addOrUpdateProperty("WinRM_Https", new PropertyValue(this.getPort(nicId)));
            var tags = this.getTags(nicId);
            if (tags) {
                for (var tag in tags) {
                    resource.addOrUpdateProperty(tag, new PropertyValue(tags[tag]));
                }
            }
            resources.push(resource);
        }
        return resources;
    }

    private parseVMDetails(virtualMachines: Array<any>): void {
        this.nicIds = [];
        var tags = {};
        for (var i = 0; i < virtualMachines.length; i++) {
            var vm = virtualMachines[i];
            var nicId = vm.properties["networkProfile"]["networkInterfaces"][0]["id"];
            this.nicIds.push(nicId);
            if (vm["tags"] != undefined)
                tags[nicId] = vm["tags"];
        }
        this.nicIdToTagsMap = tags;
    }

    private parseNetworkInterfaceDetails(networkInterfaces: Array<any>): void {
        var interfaces = {};
        for (var i = 0; i < networkInterfaces.length; i++) {
            var networkInterface = networkInterfaces[i];
            var nicId = networkInterface["id"];
            var ipConfig = networkInterface.properties["ipConfigurations"][0].properties;
            if (ipConfig["publicIPAddress"]) {
                interfaces[nicId] = { publicAddress: ipConfig["publicIPAddress"]["id"] };
            } else if (ipConfig["loadBalancerInboundNatRules"]) {
                interfaces[nicId] = { inboundNatRule: ipConfig["loadBalancerInboundNatRules"] };
            }
        }
        this.publicAddressToNicIdMap = interfaces;
    }

    private parsePublicIPDetails(publicAddresses: Array<any>): void {
        var fqdns = {}
        for (var i = 0; i < publicAddresses.length; i++) {
            var publicAddress = publicAddresses[i];
            var publicAddressId = publicAddress["id"];
            if (publicAddress["dnsSettings"]) {
                fqdns[publicAddressId] = publicAddress["dnsSettings"]["fqdn"];
            }
            else {
                fqdns[publicAddressId] = publicAddress["ipAddress"];
            }
        }
        this.publicAddressToFqdnMap = fqdns;
    }
}
