import boto3

EC2 = boto3.client("ec2")

INSTANCE_NAME = "xxx"
NON_STOPPABLE = {"stopped", "stopping", "shutting-down", "terminated"}
NON_STARTABLE = {"running", "pending"}

ACTIONS = {
    "start": {"method": EC2.start_instances, "non_eligible": NON_STARTABLE},
    "stop": {"method": EC2.stop_instances, "non_eligible": NON_STOPPABLE},
}


def lambda_handler(event, context):
    action = event.get("action", "stop").lower()
    
    if action not in ACTIONS:
        return {"error": f"Action '{action}' not supported. Use 'start' or 'stop'"}
    
    response = EC2.describe_instances(
        Filters=[{"Name": "tag:Name", "Values": [INSTANCE_NAME]}]
    )
    
    instances = [
        instance
        for reservation in response["Reservations"]
        for instance in reservation["Instances"]
    ]
    
    if not instances:
        print(f"No instance named '{INSTANCE_NAME}' found.")
        return {action: []}
    
    modified_ids = []
    for instance in instances:
        instance_id = instance["InstanceId"]
        state = instance["State"]["Name"]
        
        if state in ACTIONS[action]["non_eligible"]:
            print(f"Instance {instance_id} is already '{state}', skipping.")
            continue
        
        try:
            print(f"{action.capitalize()}ing {instance_id} (state: {state})")
            ACTIONS[action]["method"](InstanceIds=[instance_id])
            modified_ids.append(instance_id)
        except Exception as e:
            print(f"Error {action}ing {instance_id}: {e}")
    
    return {action: modified_ids}