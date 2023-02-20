import Globals from "../globals";
import {getAWSPagedResults, throttledCall} from "../utils";
import DomainConfig = require("../models/domain-config");
import {Route53} from "aws-sdk";

class Route53Wrapper {
    public route53: Route53;

    constructor(profile?: string, region?: string) {
        let credentials = Globals.serverless.providers.aws.getCredentials();
        credentials.region = Globals.serverless.providers.aws.getRegion();
        credentials.httpOptions = Globals.serverless.providers.aws.sdk.config.httpOptions;

        if (profile) {
            credentials = {
                credentials: new Globals.serverless.providers.aws.sdk.SharedIniFileCredentials({
                    profile
                }),
                region: region || credentials.region,
                httpOptions: credentials.httpOptions
            };
        }
        this.route53 = new Globals.serverless.providers.aws.sdk.Route53(credentials);
    }

    /**
     * Change A Alias record through Route53 based on given action
     * @param action: String descriptor of change to be made. Valid actions are ['UPSERT', 'DELETE']
     * @param domain: DomainInfo object containing info about custom domain
     */
    public async changeResourceRecordSet(action: string, domain: DomainConfig): Promise<void> {
        if (domain.createRoute53Record === false) {
            Globals.logInfo(`Skipping ${action === "DELETE" ? "removal" : "creation"} of Route53 record.`);
            return;
        }
        // Set up parameters
        const route53HostedZoneId = await this.getRoute53HostedZoneId(domain, domain.hostedZonePrivate);
        const route53Params = domain.route53Params;
        const route53healthCheck = route53Params.healthCheckId ? {HealthCheckId: route53Params.healthCheckId} : {};
        const domainInfo = domain.domainInfo ?? {
            domainName: domain.givenDomainName,
            hostedZoneId: route53HostedZoneId,
            domainNameCloudflare : domain.givenDomainNameCloudflare,
        };

        let routingOptions = {};
        if (route53Params.routingPolicy === Globals.routingPolicies.latency) {
            routingOptions = {
                Region: this.route53.config.region,
                SetIdentifier: domain.route53Params.setIdentifier ?? domainInfo.domainName,
                ...route53healthCheck,
            };
        }

        if (route53Params.routingPolicy === Globals.routingPolicies.weighted) {
            routingOptions = {
                Weight: domain.route53Params.weight,
                SetIdentifier: domain.route53Params.setIdentifier ?? domainInfo.domainName,
                ...route53healthCheck,
            };
        }

        let hostedZoneIds: string[];
        if (domain.splitHorizonDns) {
            hostedZoneIds = await Promise.all([
                this.getRoute53HostedZoneId(domain, false),
                this.getRoute53HostedZoneId(domain, true),
            ]);
        } else {
            hostedZoneIds = [route53HostedZoneId];
        }

        const recordsToCreate = ["CNAME"];
        for (const hostedZoneId of hostedZoneIds) {
            const changes = recordsToCreate.map((Type) => ({
                Action: action,
                ResourceRecordSet: {
                    AliasTarget: {
                        DNSName: domainInfo.domainNameCloudflare,
                        EvaluateTargetHealth: false,
                        HostedZoneId: domainInfo.hostedZoneId,
                    },
                    Name: domain.givenDomainName,
                    Type,
                    ...routingOptions,
                },
            }));
            const params = {
                ChangeBatch: {
                    Changes: changes,
                    Comment: `Record created by "${Globals.pluginName}"`,
                },
                HostedZoneId: hostedZoneId,
            };
            // Make API call
            try {
                await throttledCall(this.route53, "changeResourceRecordSets", params);
            } catch (err) {
                throw new Error(
                    `Failed to ${action} ${recordsToCreate.join(",")} Alias for '${domain.givenDomainName}':\n
                    ${err.message}`
                );
            }
        }
    }

    /**
     * Gets Route53 HostedZoneId from user or from AWS
     */
    public async getRoute53HostedZoneId(domain: DomainConfig, isHostedZonePrivate?: boolean): Promise<string> {
        if (domain.hostedZoneId) {
            Globals.logInfo(`Selected specific hostedZoneId ${domain.hostedZoneId}`);
            return domain.hostedZoneId;
        }

        const isPrivateDefined = typeof isHostedZonePrivate !== "undefined";
        if (isPrivateDefined) {
            const zoneTypeString = isHostedZonePrivate ? "private" : "public";
            Globals.logInfo(`Filtering to only ${zoneTypeString} zones.`);
        }

        let hostedZones = [];
        try {
            hostedZones = await getAWSPagedResults(
                this.route53,
                "listHostedZones",
                "HostedZones",
                "Marker",
                "NextMarker",
                {}
            );
        } catch (err) {
            throw new Error(`Unable to list hosted zones in Route53.\n${err.message}`);
        }

        const targetHostedZone = hostedZones
            .filter((hostedZone) => {
                return !isPrivateDefined || isHostedZonePrivate === hostedZone.Config.PrivateZone;
            })
            .filter((hostedZone) => {
                const hostedZoneName = hostedZone.Name.replace(/\.$/, "");
                return domain.givenDomainName.endsWith(hostedZoneName);
            })
            .sort((zone1, zone2) => zone2.Name.length - zone1.Name.length)
            .shift();

        if (targetHostedZone) {
            return targetHostedZone.Id.replace("/hostedzone/", "");
        } else {
            throw new Error(`Could not find hosted zone '${domain.givenDomainName}'`);
        }
    }
}

export = Route53Wrapper;
